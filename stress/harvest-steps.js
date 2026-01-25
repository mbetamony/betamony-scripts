const { chromium } = require("playwright");
const fs = require("fs");
require("dotenv").config();
const BASE_URL = process.env.BASE_URL;
const QA_EMAIL = process.env.QA_EMAIL;
const ARTEMIS_EMAIL = process.env.ARTEMIS_EMAIL;
const PACKAGE_PATH = process.env.PACKAGE_PATH 
const JOURNAL_ID = process.env.JOURNAL_ID;
const TYPE_ID = process.env.TYPE_ID;
const MODE = process.env.MODE || "upload"; // either upload or blank

console.log(TYPE_ID);

const OUTPUT_FILE =
  MODE === "upload"
    ? process.env.RECORDED_STEPS_PKG
    : process.env.RECORDED_STEPS_BLANK;

const CURRENT_EMAIL = MODE === "blank" ? ARTEMIS_EMAIL : QA_EMAIL;

const recordedSteps = [];

(async () => {
  if (MODE === "upload" && !fs.existsSync(PACKAGE_PATH)) {
    console.error(`[ERROR] Package file '${PACKAGE_PATH}' not found.`);
    process.exit(1);
  }
  console.log(`\nSTARTING HARVESTER [Mode: ${MODE.toUpperCase()}]`);
  console.log(`User: ${CURRENT_EMAIL}`);
  console.log(`Output: ${OUTPUT_FILE}`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log("Logging in...");
    await page.goto(
      `${BASE_URL}/action/QATestActions?test=impersonate&email=${CURRENT_EMAIL}`,
    );
    await page.waitForTimeout(1000);

    let submissionId = null;
    console.log("Creating submission via API...");

    if (MODE === "upload") {
      const b64String = fs.readFileSync(PACKAGE_PATH, "utf-8").trim();
      const buffer = Buffer.from(b64String, "base64");
      const response = await context.request.post(
        `${BASE_URL}/lw/submission/upload`,
        {
          headers: { Accept: "application/json" },
          multipart: {
            package: {
              name: "package.zip",
              mimeType: "application/zip",
              buffer: buffer,
            },
            parserUri: "leanworkflow-parser",
          },
        },
      );
      if (!response.ok())
        throw new Error(`Upload failed: ${response.status()}`);
      submissionId = (await response.json()).id;
    } else {
      const query = `
                mutation CreateSubmission($typeId: ID!, $journalId: ID!) {
                    createSubmission(typeId: $typeId, journalId: $journalId) { id }
                }
            `;
      const response = await context.request.post(`${BASE_URL}/lw/graphql`, {
        data: {
          operationName: "CreateSubmission",
          variables: { journalId: JOURNAL_ID, typeId: TYPE_ID },
          query: query,
        },
      });
      if (!response.ok())
        throw new Error(`Create failed: ${response.status()}`);
      const body = await response.json();
      if (body.errors) throw new Error(body.errors[0].message);
      submissionId = body.data.createSubmission.id;
    }

    console.log(`Submission ID: ${submissionId}`);
    console.log("Waiting for Editor to be ready...");
    let isReady = false;
    while (!isReady) {
      const res = await context.request.get(
        `${BASE_URL}/lw/debug/${submissionId}`,
        {
          headers: { Accept: "application/json" },
        },
      );
      if (res.ok()) {
        const body = await res.json();
        try {
          const metadata = JSON.parse(body.queries.metadata);
          const status = metadata.data.submission.currentStep.status.id;
          if (status === "waiting") isReady = true;
        } catch (e) {}
      }
      if (!isReady) await page.waitForTimeout(1000);
    }

    if (MODE === "upload") {
      await page.goto(
        `${BASE_URL}/action/updateManuscriptRole?role=manuscript-editor&uri=${submissionId}`,
      );
      await page.waitForTimeout(1000);
    }

    await page.route("**/steps", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const postData = request.postDataJSON();
        if (postData && postData.steps) {
          console.log(`Captured batch of ${postData.steps.length} steps`);
          recordedSteps.push({ steps: postData.steps });
        }
      }
      await route.continue();
    });

    await page.goto(`${BASE_URL}/editor/${submissionId}`);

    console.log("RECORDING STARTED");
    console.log("Type in the browser window.");
    console.log("Press CTRL+C in this terminal to Save & Exit.");

    await new Promise(() => {}); // Keep alive
  } catch (e) {
    console.error("Error:", e);
    await browser.close();
  }
})();

process.on("SIGINT", () => {
  console.log(`saving ${recordedSteps.length} batches to '${OUTPUT_FILE}'...`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(recordedSteps, null, 2));
  console.log("Done.");
  process.exit();
});
