import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { b64decode } from "k6/encoding";
import { Rate, Trend, Counter } from "k6/metrics";

// --- CONFIGURATION ---
const BASE_URL =
  __ENV.BASE_URL || "https://dev1-lean-x7481.literatumonline.com";
const MANUSCRIPTS_API_BASE =
  __ENV.MANUSCRIPTS_API_BASE ||
  "https://lwf-manuscripts-api-dev1.literatumonline.com";
const QA_EMAIL = __ENV.QA_EMAIL || "leanworkflow-qa%2Bautomation%40atypon.com";
const ARTEMIS_EMAIL =
  __ENV.ARTEMIS_EMAIL || "leanworkflow-qa%2Bartemis%40atypon.com";

const JOURNAL_ID = __ENV.JOURNAL_ID || "cdd79f1c-c8a1-4aa2-a146-1a152aeb1a06";
const TYPE_ID = __ENV.TYPE_ID || "dpblog";

// Toggle for infinite editing loop (Default: true)
const REPEAT_BLANK = (__ENV.REPEAT_BLANK || "true") === "true";

// Paths
const PATH_PKG = __ENV.RECORDED_STEPS_PKG || "./recorded_steps_pkg.json";
const PATH_BLANK = __ENV.RECORDED_STEPS_BLANK || "./recorded_steps_blank.json";
const PATH_BIN = __ENV.PACKAGE_PATH || "./package.b64";

// --- METRICS ---
const uploadSuccess = new Rate("upload_success");
const createSuccess = new Rate("create_success");
const stepSuccess = new Rate("step_success");
const cleanupSuccess = new Rate("cleanup_success");
const editorReadySuccess = new Rate("editor_ready_success");

const wmRequests = new Counter("reqs_wm");
const manuscriptsRequests = new Counter("reqs_manuscripts");

const stepLatency = new Trend("step_latency");
const uploadReqDuration = new Trend("upload_req_duration");
const createReqDuration = new Trend("create_req_duration");
const ingestionDuration = new Trend("ingestion_duration"); // Worker speed
const startupDuration = new Trend("startup_duration"); // DB speed
const sessionDuration = new Trend("session_duration"); // Total lifecycle

// --- DATA ---
const STEPS_PKG = new SharedArray("steps_pkg", () =>
  JSON.parse(open(PATH_PKG)),
);
const STEPS_BLANK = new SharedArray("steps_blank", () =>
  JSON.parse(open(PATH_BLANK)),
);
const PACKAGE_BIN = b64decode(open(PATH_BIN).trim());

const QUERY_AUTH = JSON.stringify({
  operationName: "Authenticate",
  variables: {},
  query: `query Authenticate { editorAuthToken }`,
});

const QUERY_CREATE = JSON.stringify({
  operationName: "CreateSubmission",
  variables: { journalId: JOURNAL_ID, typeId: TYPE_ID },
  query: `mutation CreateSubmission($typeId: ID!, $journalId: ID!) {
        createSubmission(typeId: $typeId, journalId: $journalId) { id }
    }`,
});

export const options = {
  scenarios: {
    upload_workflow: {
      exec: "runUploadWorkflow",
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 50 },
        { duration: "10m", target: 50 },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
    blank_workflow: {
      exec: "runBlankWorkflow",
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 75 },
        { duration: "10m", target: 75 },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    upload_success: ["rate>0.9"],
    create_success: ["rate>0.9"],
    step_success: ["rate>0.95"],
    cleanup_success: ["rate>0.95"],
    // Optional: Add latency alert (fail if typing takes > 500ms)
    // step_latency: ["p(95)<500"],
  },
};

export function runUploadWorkflow() {
  runStressCycle("upload");
}

export function runBlankWorkflow() {
  runStressCycle("blank");
}

// --- API ACTIONS ---

const uploadSubmission = () => {
  const filePackage = http.file(PACKAGE_BIN, "package.zip", "application/zip");
  const uploadRes = http.post(
    `${BASE_URL}/lw/submission/upload`,
    {
      package: filePackage,
      parserUri: "leanworkflow-parser",
    },
    {
      headers: { Accept: "application/json" },
      timeout: "60s",
    },
  );

  wmRequests.add(1);
  uploadReqDuration.add(uploadRes.timings.duration);

  const isOk = check(uploadRes, { "Upload 200": (r) => r.status === 200 });
  uploadSuccess.add(isOk);

  if (!isOk) {
    console.error(
      `[VU ${__VU}] ❌ Upload Failed: ${uploadRes.status} | Body: ${uploadRes.body.slice(0, 200)}`,
    );
    return null;
  }

  try {
    return JSON.parse(uploadRes.body).id;
  } catch (e) {
    console.error(`[VU ${__VU}] ❌ Upload Parse Error: ${e.message}`);
    return null;
  }
};

const createBlankSubmission = () => {
  loginWM(ARTEMIS_EMAIL);

  const res = http.post(`${BASE_URL}/lw/graphql`, QUERY_CREATE, {
    headers: { "Content-Type": "application/json" },
  });

  wmRequests.add(1);
  createReqDuration.add(res.timings.duration);

  const isOk = check(res, { "Create 200": (r) => r.status === 200 });
  createSuccess.add(isOk);

  if (!isOk) {
    console.error(
      `[VU ${__VU}] ❌ Create Failed: ${res.status} | Body: ${res.body.slice(0, 200)}`,
    );
    return null;
  }

  try {
    const body = JSON.parse(res.body);
    if (body.errors) throw new Error(body.errors[0].message);
    return body.data.createSubmission.id;
  } catch (e) {
    console.error(`[VU ${__VU}] ❌ Create Logic Error: ${e.message}`);
    return null;
  }
};

const pollSubmission = (submissionId, durationMetric) => {
  let manuscriptId = null;
  let projectId = null;
  let isReady = false;
  const start = Date.now();
  let attempts = 0;
  let sleepTime = 2;

  // Poll for up to ~2 minutes
  while (!isReady && attempts < 25) {
    sleep(sleepTime);
    sleepTime = Math.min(10, sleepTime * 1.5);

    const res = http.get(`${BASE_URL}/lw/debug/${submissionId}`, {
      headers: { Accept: "application/json" },
    });
    wmRequests.add(1);

    if (res.status === 200) {
      try {
        const sub = JSON.parse(JSON.parse(res.body).queries.metadata).data
          .submission;
        if (sub.currentStep.status.id === "waiting" && sub.documentId) {
          [projectId, manuscriptId] = sub.documentId.split("#");
          if (projectId && manuscriptId) isReady = true;
        }
      } catch (e) {}
    }
    attempts++;
  }

  if (isReady) {
    editorReadySuccess.add(1);
    durationMetric.add(Date.now() - start);
  } else {
    editorReadySuccess.add(0);
    console.error(
      `[VU ${__VU}] ❌ Timeout waiting for ready state: ${submissionId}`,
    );
  }

  return { projectId, manuscriptId };
};

const loginWM = (email) => {
  http.get(`${BASE_URL}/action/QATestActions?test=impersonate&email=${email}`);
  wmRequests.add(1);
};

const loginManuscripts = (submissionId) => {
  http.get(
    `${BASE_URL}/action/updateManuscriptRole?role=manuscript-editor&uri=${submissionId}`,
  );
  wmRequests.add(1);

  const res = http.post(`${BASE_URL}/lw/graphql`, QUERY_AUTH, {
    headers: { "Content-Type": "application/json" },
  });
  wmRequests.add(1);

  try {
    return JSON.parse(res.body).data.editorAuthToken;
  } catch (e) {
    throw new Error("Auth Token not found in response");
  }
};

const stepsSince = (manuscriptId, projectId, token, version) => {
  http.get(
    `${MANUSCRIPTS_API_BASE}/api/v2/doc/${projectId}/manuscript/${manuscriptId}/version/${version}`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    },
  );
  manuscriptsRequests.add(1);
};

const activeWait = (token, projectId, manuscriptId, version, seconds) => {
  const start = Date.now();
  do {
    // Ping backend to simulate connected user
    stepsSince(manuscriptId, projectId, token, version);
    // Don't sleep if time is already up
    if (Date.now() - start < seconds * 1000) sleep(2);
  } while (Date.now() - start < seconds * 1000);
};

const applySteps = (token, projectId, manuscriptId, stepsArray, repeat) => {
  const STEPS_URL = `${MANUSCRIPTS_API_BASE}/api/v2/doc/${projectId}/manuscript/${manuscriptId}/steps`;

  // Increased to 300 to reduce pressure on Creation API and focus on Editor API
  const loopCount = repeat ? 300 : 1;
  const totalSteps = stepsArray.length * loopCount;

  console.log(`[VU ${__VU}] Applying ${totalSteps} total batches...`);

  let currentVersion = 0;

  for (let cycle = 0; cycle < loopCount; cycle++) {
    for (let i = 0; i < stepsArray.length; i++) {
      const batch = stepsArray[i];

      const res = http.post(
        STEPS_URL,
        JSON.stringify({
          steps: batch.steps,
          version: currentVersion,
          clientID: __VU,
        }),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        },
      );

      manuscriptsRequests.add(1);
      stepLatency.add(res.timings.duration);

      const isOk = check(res, { "Step OK": (r) => r.status === 200 });
      stepSuccess.add(isOk);

      if (isOk) {
        try {
          const body = JSON.parse(res.body);
          currentVersion = body.version || currentVersion + batch.steps.length;
        } catch (e) {
          currentVersion += batch.steps.length;
        }
      } else {
        // Log detailed failure for debugging
        console.error(
          `[VU ${__VU}] ❌ Step Failed: ${res.status} | Body: ${res.body}`,
        );
        return; // Stop applying steps if one fails
      }

      // Random "Think Time" (typing pause)
      const thinkTime = Math.random() * 9 + 1;
      activeWait(token, projectId, manuscriptId, currentVersion, thinkTime);
    }
  }
};

const cleanupSubmission = (submissionId) => {
  const res = http.post(`${BASE_URL}/lw/cleanup/${submissionId}`, null, {
    headers: { Cookie: "I2BRK=1" },
  });
  wmRequests.add(1);

  const isOk = check(res, {
    "Cleanup OK": (r) => r.status === 200 || r.status === 204,
  });
  cleanupSuccess.add(isOk);

  if (isOk) {
    console.log(`[VU ${__VU}] ✅ Cleaned: ${submissionId}`);
  } else {
    console.error(`[FAILED_CLEANUP] ${submissionId}`);
  }
};

function runStressCycle(mode) {
  const jar = http.cookieJar();
  jar.set(BASE_URL, "I2BRK", "1");

  const sessionStart = Date.now();

  let submissionId = null;
  let email = QA_EMAIL;
  let stepsToApply = STEPS_PKG;
  let repeat = false;
  let durationMetric = null;

  try {
    if (mode === "upload") {
      submissionId = uploadSubmission();
      durationMetric = ingestionDuration;
    } else {
      submissionId = createBlankSubmission();
      email = ARTEMIS_EMAIL;
      stepsToApply = STEPS_BLANK;
      repeat = true;
      durationMetric = startupDuration;
    }

    if (!submissionId) return; // Exit if creation failed

    console.log(`[VU ${__VU}] [${mode}] Start: ${submissionId}`);

    const { projectId, manuscriptId } = pollSubmission(
      submissionId,
      durationMetric,
    );

    if (!projectId || !manuscriptId) throw new Error("ID Discovery Failed");

    if (mode === "upload") loginWM(email);
    const authToken = loginManuscripts(submissionId);

    // Run steps (with REPEAT_BLANK check)
    applySteps(
      authToken,
      projectId,
      manuscriptId,
      stepsToApply,
      repeat && REPEAT_BLANK,
    );
  } catch (error) {
    console.error(`[VU ${__VU}] ❌ Error: ${error.message}`);
  } finally {
    if (submissionId) cleanupSubmission(submissionId);

    // Record total time this VU spent in the workflow
    sessionDuration.add(Date.now() - sessionStart);
  }
}
