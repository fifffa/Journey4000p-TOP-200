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

function SortAndSlice(result, slice = 100) {
  let data = [...result];

  data.sort((a, b) => {
    const positionsA = Number(
      HanTools.parseNumber(a.prices.price.replace(",", ""))
    );
    const positionsB = Number(
      HanTools.parseNumber(b.prices.price.replace(",", ""))
    );

    // // Sort in descending order based on average position value
    console.log("positionsB:", positionsB);
    return positionsB - positionsA;
  });

  data = data.slice(0, slice);

  console.log("data:", data);

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
      id: "챔피언스 저니 6000p",
      updateTime: "",
      seasonPack: [],
    };

    const BTB_TOP_90 = {
      packName: "BTB Top 90",
      playerPrice: [],
    };

    const SPL_TOP_75 = {
      packName: "SPL TOP 75",
      playerPrice: [],
    };

    const HG_TOP_100 = {
      packName: "HG TOP 100",
      playerPrice: [],
    };

    const NG23_TOP_65 = {
      packName: "23NG TOP 65",
      playerPrice: [],
    };

    const LOL_FA_22HEROES_TOP_80 = {
      packName: "LOL,FA,22HEROES TOP 80",
      playerPrice: [],
    };

    const NTG_UP_VTR_MOG_LH_TKL_TOP_100 = {
      packName: "NTG,UP,VTR,MOG,LH,TKL TOP 100",
      playerPrice: [],
    };
    const UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_TOP_350 =
      {
        packName:
          "UT,JNM,24HEROES,DC,JVA,CC,FCA,23HW,HG,RTN,23HEROES,RMCF,LN,SPL,23NG,LOL,FA,23KFA,22HEROES,BTB,CAP,CFA,EBS,BOE21,NTG,UP,22KFA TOP 350",
        playerPrice: [],
      };

    const RTN_TOP_70 = {
      packName: "RTN TOP 70",
      playerPrice: [],
    };
    const RMCF_TOP_80 = {
      packName: "RMCF 포함 TOP 80",
      playerPrice: [],
    };
    const HEROES23_TOP_75 = {
      packName: "23HEROES 포함 TOP 75",
      playerPrice: [],
    };

    await dbConnect();

    // // -------------------------------------- ICON_TOP_ALL--------------------------------------

    const ICONTM_LIST = await playerSearch([100], 0); // playerSearch(시즌넘버, 최소오버롤)
    let ICONTM_RESULTS = await playerPriceValue(ICONTM_LIST, 5); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(ICONTM_RESULTS);
    const ICONTM_FINAL = SortAndSlice(ICONTM_RESULTS); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of ICONTM_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        ICON_TM_TOP_ALL.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...ICON_TM_TOP_ALL });

    // // // -------------------------------------- KB24_ALL--------------------------------------

    const KB24_LIST = await playerSearch([830], 0); // playerSearch(시즌넘버, 최소오버롤)
    let KB24_RESULTS = await playerPriceValue(KB24_LIST, 8); // playerPriceValue(데이터 , 강화등급)
    console.log("KB24_RESULTS:", KB24_RESULTS);
    await saveToDB(KB24_RESULTS);
    const KB24_FINAL = SortAndSlice(KB24_RESULTS); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of KB24_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });

        KB24_TOP_ALL.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...KB24_TOP_ALL });

    // // -------------------------------------- ICONS MATCH, ICON, UT, JNM, 24HEROES, DC, JVA, CC, FCA, 23HW, HG, RTN, 23HEROES,RMCF _TOP 550--------------------------------------

    const ICONMATCH_LIST = await playerSearch(
      [111, 101, 814, 813, 811, 802, 801, 289, 290, 291, 283, 284, 281, 274],
      110
    ); // playerSearch(시즌넘버, 최소오버롤)
    let ICONMATCH_RESULTS = await playerPriceValue(
      ICONMATCH_LIST,
      [5, 6, 7, 8]
    ); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(ICONMATCH_RESULTS);
    const ICONMATCH_FINAL = SortAndSlice(ICONMATCH_RESULTS, 550); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of ICONMATCH_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });

        ICONS_MATCHANDICON.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...ICONS_MATCHANDICON });

    // // --------------------------------------  UT, JNM, 24HEROES, DC, JVA, CC, FCA, 23HW, HG, RTN, 23HEROES, RMCF, LN, SPL, 23NG, LOL, FA, 23KFA, 22HEROES, BTB, CAP, CFA, EBS TOP 400--------------------------------------

    // const UT_TOP_400_LIST = await playerSearch(
    //   [
    //     814, 813, 811, 802, 801, 289, 290, 291, 283, 284, 281, 274, 268, 270,
    //     804, 265, 264, 806, 261, 256, 252, 254, 251,
    //   ],
    //   104
    // ); // playerSearch(시즌넘버, 최소오버롤)
    // let UT_TOP_400_RESULTS = await playerPriceValue(UT_TOP_400_LIST, 8); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(UT_TOP_400_RESULTS);
    // const UT_TOP_400_FINAL = SortAndSlice(UT_TOP_400_RESULTS, 400); // SortAndSlice(데이터 , 자르기숫자)
    // for (let item of UT_TOP_400_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //     };
    //     playerDocs.map((p) => {
    //       playerData.playerPrice = p._id;
    //     });

    //     UT_TOP_400.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...UT_TOP_400 });

    const doc = await EventValueChart.findOne({ id: "아이콘 로드 3500" });

    let mergedSeasonPacks = [];

    if (doc) {
      // 2. 기존 seasonPack 가져오기
      const existingSeasonPacks = doc.seasonPack;

      // 3. 병합: 같은 packName이면 덮어쓰고, 없으면 추가
      mergedSeasonPacks = [...existingSeasonPacks];

      for (const incoming of data.seasonPack) {
        const index = mergedSeasonPacks.findIndex(
          (pack) => pack.packName === incoming.packName
        );

        if (index > -1) {
          // 같은 packName 있으면 덮어쓰기
          mergedSeasonPacks[index] = {
            ...mergedSeasonPacks[index],
            ...incoming,
          };
        } else {
          // 없으면 추가
          mergedSeasonPacks.push(incoming);
        }
      }
    } else {
      // 문서 없을 경우 새로 만듦
      mergedSeasonPacks = data.seasonPack;
    }

    // 4. 최종 업데이트
    await EventValueChart.updateOne(
      { id: "아이콘 로드 3500" },
      {
        $set: {
          updateTime: new Date(),
          seasonPack: mergedSeasonPacks,
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
