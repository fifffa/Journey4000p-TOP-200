import { chromium } from "playwright-core";
import mongoose from "mongoose";
import Price from "./models/price.js"; // 확장자 포함 권장 (ESM 기준)
import EventValueChart from "./models/eventValueChart.js";
import PlayerReports from "./models/playerReports.js";
// import data from "./data.json" assert { type: "json" };
import dbConnect from "./dbConnect.js";
import HanTools from "hangul-tools";
import axios from "axios";

let browser;

async function initBrowser() {
  if (browser) {
    try {
      await browser.close();
      console.log("🔄 Previous browser closed");
    } catch (error) {
      console.error("⚠ Error closing previous browser:", error.message);
    }
  }

  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.NODE_ENV === "production"
        ? process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable"
        : undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-gpu",
      "--no-zygote",
    ],
    ignoreHTTPSErrors: true,
  });

  console.log("✅ Playwright browser initialized");
}

// async function dbConnect() {
//   if (mongoose.connection.readyState !== 1) {
//     await mongoose.connect(process.env.MONGO_URI, {
//       useNewUrlParser: true,
//       useUnifiedTopology: true,
//     });
//     console.log("✅ MongoDB connected");
//   }
// }

async function blockUnwantedResources(page) {
  await page.route("**/*", (route) => {
    const blockedTypes = new Set(["image", "stylesheet", "font", "media"]);
    const blockedDomains = ["google-analytics.com", "doubleclick.net"];
    const url = route.request().url();

    if (
      blockedTypes.has(route.request().resourceType()) ||
      blockedDomains.some((domain) => url.includes(domain))
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });
}

async function playerPriceValue(data, Grade) {
  let context;
  let grades;

  if (Array.isArray(Grade)) {
    grades = [...Grade];
  } else {
    grades = [Grade];
  }

  try {
    await initBrowser();
    context = await browser.newContext();
    const results = [];

    for (let grade of grades) {
      for (const player of data) {
        const { id } = player;
        const url = `https://fconline.nexon.com/DataCenter/PlayerInfo?spid=${id}&n1Strong=${grade}`;
        const page = await context.newPage();
        await blockUnwantedResources(page);

        try {
          console.log(`🌍 Navigating to ${url}`);
          await page.goto(url, { waitUntil: "domcontentloaded" });

          await page.waitForFunction(
            () => {
              const element = document.querySelector(".txt strong");
              return (
                element &&
                element.getAttribute("title") &&
                element.getAttribute("title").trim() !== ""
              );
            },
            { timeout: 80000 }
          );

          let datacenterTitle = await page.evaluate(() => {
            const element = document.querySelector(".txt strong").textContent;
            return element;
          });

          results.push({
            id: id,
            prices: { grade, price: datacenterTitle },
          });

          console.log(`✔ ID ${id} / Grade ${grade} → ${datacenterTitle}`);
        } catch (err) {
          console.error(`❌ Error for ID ${id}, Grade ${grade}:`, err.message);
          results.push({
            id: id,
            prices: { grade, price: "Error" },
          });
        } finally {
          await page.close();
        }
      }
    }

    return results;
  } finally {
    await context?.close();
    await browser?.close();
  }
}

async function saveToDB(results) {
  const bulkOps = results.map(({ id, prices }) => ({
    updateOne: {
      filter: { id: String(id), "prices.grade": prices.grade },
      update: {
        $set: { "prices.$[elem].price": prices.price },
      },
      arrayFilters: [{ "elem.grade": prices.grade }],
      upsert: true,
    },
  }));

  if (bulkOps.length > 0) {
    try {
      await Price.bulkWrite(bulkOps);
      console.log("📦 MongoDB updated");
    } catch (error) {
      console.error("❌ MongoDB bulkWrite failed:", error.message);
    }
  } else {
    console.log("⚠ No data to save");
  }
}

function SortAndSlice(result, slice) {
  let data = [...result];

  data.sort((a, b) => {
    const positionsA = Number(
      HanTools.parseNumber(a.prices.price.replace(",", ""))
    );
    const positionsB = Number(
      HanTools.parseNumber(b.prices.price.replace(",", ""))
    );

    return positionsB - positionsA;
  });

  if (slice !== undefined && slice !== null) {
    data = data.slice(0, slice);
  }

  return data;
}

const playerSearch = async (selectedSeason = "", minOvr = 0) => {
  let selectedSeasons;
  if (Array.isArray(selectedSeason)) {
    selectedSeasons = [...selectedSeason];
  } else {
    selectedSeasons = [selectedSeason];
  }
  const seasonNumbers = [];
  const inputplayer = "";

  // 이미 배열 형태로 전달된 selectedSeasons과 selectedPositions 사용

  for (let season of selectedSeasons) {
    seasonNumbers.push(Number(String(season).slice(-3)));
  }

  let playerReports = [];

  const queryCondition = [{ name: new RegExp(inputplayer) }];

  if (minOvr && minOvr > 10) {
    queryCondition.push({
      "능력치.포지션능력치.최고능력치": {
        $gte: Number(minOvr),
      },
    });
  }

  if (seasonNumbers && seasonNumbers.length > 0) {
    for (let seasonNumber of seasonNumbers) {
      seasonNumber *= 1000000;

      const seasonCondition = {
        id: {
          $gte: seasonNumber,
          $lte: seasonNumber + 999999,
        },
      };

      queryCondition.push(seasonCondition);

      let playerReport = await PlayerReports.find({
        $and: queryCondition,
      })
        .populate({
          path: "선수정보",
          populate: {
            path: "prices", // 중첩된 필드를 처리
            model: "Price",
          },
        })
        .populate({
          path: "선수정보.시즌이미지",
          populate: {
            path: "시즌이미지",
            model: "SeasonId",
          },
        })
        .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
        .limit(10000);
      queryCondition.pop();
      playerReports = playerReports.concat(playerReport);
    }
  } else {
    let playerReport = await PlayerReports.find({
      $and: queryCondition,
    })
      .populate({
        path: "선수정보",
        populate: {
          path: "prices", // 중첩된 필드를 처리
          model: "Price",
        },
      })
      .populate({
        path: "선수정보.시즌이미지",
        populate: {
          path: "시즌이미지",
          model: "SeasonId",
        },
      })
      .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
      .limit(10000);

    playerReports = playerReports.concat(playerReport);
  }

  return playerReports;
};

async function main() {
  try {
    const data = {
      id: "챔피언스 저니 4000p",
      updateTime: "",
      seasonPack: [],
    };

    const JNM_TOP_300 = {
      packName: "JNM 포함 Top Price 300 스페셜팩 (8강, 90+)",
      playerPrice: [],
    };
    const NTG_UP_TOP_200 = {
      packName: "NTG, UP 포함 Top Price 200 스페셜팩 (10강, 90+)",
      playerPrice: [],
    };

    await dbConnect();

    // // -------------------------------------- ICON_TOP_ALL--------------------------------------

    // const ICONTM_LIST = await playerSearch([100], 0); // playerSearch(시즌넘버, 최소오버롤)
    // let ICONTM_RESULTS = await playerPriceValue(ICONTM_LIST, 5); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(ICONTM_RESULTS);
    // const ICONTM_FINAL = SortAndSlice(ICONTM_RESULTS); // SortAndSlice(데이터 , 자르기숫자)

    // for (let item of ICONTM_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0 && playerDocs[0]._id) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //       playerPrice: playerDocs[0]?._id || null,
    //     };
    //     ICON_TM_TOP_ALL.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...ICON_TM_TOP_ALL });
    // -------------------------------------- JNM, 24HEROES, DC, JVA, CC, FCA, 23HW, HG, RTN, 23HEROES, RMCF, LN, SPL, 23NG, LOL, FA, 23KFA, 22HEROES, BTB, CAP, CFA, EBS, BOE21, NTG, UP, 22KFA, 2012KH, 21KFA, MC, LA _TOP_300--------------------------------------

    const JNM_LIST = await playerSearch(
      [
        813, 811, 802, 801, 289, 290, 291, 283, 284, 281, 274, 268, 270, 804,
        265, 264, 806, 261, 256, 252, 254, 251, 253, 249, 246, 293, 247, 294,
        237, 236,
      ],
      90
    ); // playerSearch(시즌넘버, 최소오버롤)
    let JNM_RESULTS = await playerPriceValue(JNM_LIST, 8); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(JNM_RESULTS);
    const JNM_FINAL = SortAndSlice(JNM_RESULTS, 300); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of JNM_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        JNM_TOP_300.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...JNM_TOP_300 });
    // -------------------------------------- NTG, UP, VTR, MOG, LH, TKL_TOP_200--------------------------------------

    const NTG_UP_LIST = await playerSearch([249, 246, 231, 233, 234, 225], 90); // playerSearch(시즌넘버, 최소오버롤)
    let NTG_UP_RESULTS = await playerPriceValue(NTG_UP_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(NTG_UP_RESULTS);
    const NTG_UP_FINAL = SortAndSlice(NTG_UP_RESULTS, 200); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of NTG_UP_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        NTG_UP_TOP_200.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...NTG_UP_TOP_200 });
    // -------------------------------------- LN_TOP_85--------------------------------------

    // const LN_LIST = await playerSearch([268], 103); // playerSearch(시즌넘버, 최소오버롤)
    // let LN_RESULTS = await playerPriceValue(LN_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(LN_RESULTS);
    // const LN_FINAL = SortAndSlice(LN_RESULTS, 85); // SortAndSlice(데이터 , 자르기숫자)

    // for (let item of LN_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0 && playerDocs[0]._id) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //       playerPrice: playerDocs[0]?._id || null,
    //     };
    //     LN_TOP_85.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...LN_TOP_85 });
    // // -------------------------------------- HG_TOP_90--------------------------------------

    // const HG_LIST = await playerSearch([283], 103); // playerSearch(시즌넘버, 최소오버롤)
    // let HG_RESULTS = await playerPriceValue(HG_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(HG_RESULTS);
    // const HG_FINAL = SortAndSlice(HG_RESULTS, 90); // SortAndSlice(데이터 , 자르기숫자)

    // for (let item of HG_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0 && playerDocs[0]._id) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //       playerPrice: playerDocs[0]?._id || null,
    //     };
    //     HG_TOP_90.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...HG_TOP_90 });
    // // -------------------------------------- RTN_TOP_65--------------------------------------

    // const RTN_LIST = await playerSearch([284], 99); // playerSearch(시즌넘버, 최소오버롤)
    // let RTN_RESULTS = await playerPriceValue(RTN_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(RTN_RESULTS);
    // const RTN_FINAL = SortAndSlice(RTN_RESULTS, 65); // SortAndSlice(데이터 , 자르기숫자)

    // for (let item of RTN_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0 && playerDocs[0]._id) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //       playerPrice: playerDocs[0]?._id || null,
    //     };
    //     RTN_TOP_65.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...RTN_TOP_65 });
    // // -------------------------------------- LOL_FA_TOP_50--------------------------------------

    // const LOL_FA_LIST = await playerSearch([265, 264], 103); // playerSearch(시즌넘버, 최소오버롤)
    // let LOL_FA_RESULTS = await playerPriceValue(LOL_FA_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(LOL_FA_RESULTS);
    // const LOL_FA_FINAL = SortAndSlice(LOL_FA_RESULTS, 50); // SortAndSlice(데이터 , 자르기숫자)

    // for (let item of LOL_FA_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0 && playerDocs[0]._id) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //       playerPrice: playerDocs[0]?._id || null,
    //     };
    //     LOL_FA_TOP_50.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...LOL_FA_TOP_50 });
    // // -------------------------------------- HR22_TOP_110--------------------------------------

    // const HR22_LIST = await playerSearch([261, 256, 254, 251, 247, 294], 103); // playerSearch(시즌넘버, 최소오버롤)
    // let HR22_RESULTS = await playerPriceValue(HR22_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(HR22_RESULTS);
    // const HR22_FINAL = SortAndSlice(HR22_RESULTS, 110); // SortAndSlice(데이터 , 자르기숫자)

    // for (let item of HR22_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0 && playerDocs[0]._id) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //       playerPrice: playerDocs[0]?._id || null,
    //     };
    //     HR22_TOP_110.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...HR22_TOP_110 });
    // // -------------------------------------- COC_OTW_TOP_50--------------------------------------

    // const COC_OTW_LIST = await playerSearch([217, 218, 210, 207, 206, 201], 75); // playerSearch(시즌넘버, 최소오버롤)
    // let COC_OTW_RESULTS = await playerPriceValue(COC_OTW_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(COC_OTW_RESULTS);
    // const COC_OTW_FINAL = SortAndSlice(COC_OTW_RESULTS, 50); // SortAndSlice(데이터 , 자르기숫자)

    // for (let item of COC_OTW_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0 && playerDocs[0]._id) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //       playerPrice: playerDocs[0]?._id || null,
    //     };
    //     COC_OTW_TOP_50.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...COC_OTW_TOP_50 });

    // -------------------------------------------------------------------------------------------------------------------------------

    const doc = await EventValueChart.findOne({
      id: "챔피언스 저니 4000p",
    }).lean();

    let mergedSeasonPacks = [];
    const now = new Date();
    const koreaTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);

    if (doc) {
      const existingSeasonPacks = doc.seasonPack;

      mergedSeasonPacks = [...existingSeasonPacks];

      for (const incoming of data.seasonPack) {
        const index = mergedSeasonPacks.findIndex(
          (pack) => pack.packName === incoming.packName
        );

        if (index > -1) {
          mergedSeasonPacks[index] = {
            ...mergedSeasonPacks[index],
            ...incoming,
          };
        } else {
          mergedSeasonPacks.push(incoming);
        }
      }
    } else {
      mergedSeasonPacks = data.seasonPack;
    }

    // 🔧 에러 방지를 위한 toObject 처리
    const finalSeasonPack = mergedSeasonPacks.map((pack) =>
      typeof pack.toObject === "function" ? pack.toObject() : pack
    );

    console.log("finalSeasonPack:", finalSeasonPack);

    await EventValueChart.updateOne(
      { id: "챔피언스 저니 4000p" },
      {
        $set: {
          updateTime: koreaTime,
          seasonPack: finalSeasonPack,
        },
      },
      { upsert: true }
    );

    console.log("✅ Crawling process completed.");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error in crawler:", error.message);
    process.exit(1);
  }
}

main();
