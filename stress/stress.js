import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Rate, Trend } from "k6/metrics";
import { b64decode } from "k6/encoding";

const BASE_URL = __ENV.BASE_URL || "https://dev1-lean-x7481.literatumonline.com";
const MANUSCRIPTS_API_BASE = __ENV.MANUSCRIPTS_API_BASE || "https://lwf-manuscripts-api-dev1.literatumonline.com";
const QA_EMAIL = __ENV.QA_EMAIL || "leanworkflow-qa%2Bautomation%40atypon.com";
const ARTEMIS_EMAIL = __ENV.ARTEMIS_EMAIL || "leanworkflow-qa%2Bartemis%40atypon.com";
const REPEAT_BLANK = __ENV.REPEAT_BLANK === "true";
const JOURNAL_ID = __ENV.JOURNAL_ID || "cdd79f1c-c8a1-4aa2-a146-1a152aeb1a06";
const TYPE_ID = __ENV.TYPE_ID || "dpblog";

// File paths
const PATH_PKG = __ENV.RECORDED_STEPS_PKG || "./recorded_steps_pkg.json";
const PATH_BLANK = __ENV.RECORDED_STEPS_BLANK || "./recorded_steps_blank.json";
const PATH_BIN = __ENV.PACKAGE_PATH || "./package.b64";

// --- METRICS ---
const uploadSuccess = new Rate("upload_success");
const createSuccess = new Rate("create_success");
const stepSuccess = new Rate("step_success");
const cleanupSuccess = new Rate("cleanup_success");
const editorReadySuccess = new Rate("editor_ready_success");
const editorReadyDuration = new Trend("editor_ready_duration");

// --- DATA ---
const STEPS_PKG = new SharedArray("steps_pkg", () => JSON.parse(open(PATH_PKG)));
const STEPS_BLANK = new SharedArray("steps_blank", () => JSON.parse(open(PATH_BLANK)));
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
        { duration: "2m", target: 25 },
        { duration: "10m", target: 25 },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
    blank_workflow: {
      exec: "runBlankWorkflow",
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 25 },
        { duration: "10m", target: 25 },
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
  },
};

export function runUploadWorkflow() {
  runStressCycle("upload");
}

export function runBlankWorkflow() {
  runStressCycle("blank");
}

// --- HELPER FUNCTIONS ---

const uploadSubmission = () => {
  const filePackage = http.file(PACKAGE_BIN, "package.zip", "application/zip");
  const uploadRes = http.post(`${BASE_URL}/lw/submission/upload`, {
    package: filePackage,
    parserUri: "leanworkflow-parser",
  }, {
    headers: { Accept: "application/json" },
    timeout: "60s",
  });

  const isOk = check(uploadRes, { "Upload 200": (r) => r.status === 200 });
  uploadSuccess.add(isOk);

  if (!isOk) return null;
  try { return JSON.parse(uploadRes.body).id; } catch (e) { return null; }
};

const createBlankSubmission = () => {
  loginWM(ARTEMIS_EMAIL);
  const res = http.post(`${BASE_URL}/lw/graphql`, QUERY_CREATE, {
    headers: { "Content-Type": "application/json" },
  });

  const isOk = check(res, { "Create 200": (r) => r.status === 200 });
  createSuccess.add(isOk);

  if (!isOk) return null;
  try {
    const body = JSON.parse(res.body);
    if (body.errors) throw new Error(body.errors[0].message);
    return body.data.createSubmission.id;
  } catch (e) {
    console.error(`[VU ${__VU}] Create Parse Error: ${e.message}`);
    return null;
  }
};

const pollSubmission = (submissionId) => {
  let manuscriptId = null;
  let projectId = null;
  let isReady = false;
  const start = Date.now();
  let attempts = 0;

  // Exponential Backoff: 2s -> 3s -> ... -> 10s
  let sleepTime = 2;

  while (!isReady && attempts < 25) {
    sleep(sleepTime);
    sleepTime = Math.min(10, sleepTime * 1.5);

    const res = http.get(`${BASE_URL}/lw/debug/${submissionId}`, { headers: { Accept: "application/json" } });
    if (res.status === 200) {
      try {
        const sub = JSON.parse(JSON.parse(res.body).queries.metadata).data.submission;
        if (sub.currentStep.status.id === "waiting" && sub.documentId) {
          // Standardized destructuring to camelCase variables
          [projectId, manuscriptId] = sub.documentId.split("#");
          if (projectId && manuscriptId) isReady = true;
        }
      } catch (e) {}
    }
    attempts++;
  }

  if (isReady) {
    editorReadySuccess.add(1);
    editorReadyDuration.add(Date.now() - start);
  } else {
    editorReadySuccess.add(0);
    console.error(`[VU ${__VU}] Timeout waiting for IDs`);
  }
  
  // Return consistent camelCase
  return { projectId, manuscriptId };
};

const loginWM = (email) => {
  http.get(`${BASE_URL}/action/QATestActions?test=impersonate&email=${email}`);
};

const loginManuscripts = (submissionId) => {
  http.get(`${BASE_URL}/action/updateManuscriptRole?role=manuscript-editor&uri=${submissionId}`);
  const res = http.post(`${BASE_URL}/lw/graphql`, QUERY_AUTH, { headers: { "Content-Type": "application/json" } });
  try { return JSON.parse(res.body).data.editorAuthToken; }
  catch (e) { throw new Error("Auth Failed"); }
};

const stepsSince = (manuscriptId, projectId, token, version) => {
  // Arguments are now cleanly ordered and named
  http.get(`${MANUSCRIPTS_API_BASE}/api/v2/doc/${projectId}/manuscript/${manuscriptId}/version/${version}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
};

const activeWait = (token, projectId, manuscriptId, version, seconds) => {
  const start = Date.now();
  do {
      stepsSince(manuscriptId, projectId, token, version);
      if (Date.now() - start < seconds * 1000) sleep(2);
  } while (Date.now() - start < seconds * 1000);
};

const applySteps = (token, projectId, manuscriptId, stepsArray, repeat) => {
  const STEPS_URL = `${MANUSCRIPTS_API_BASE}/api/v2/doc/${projectId}/manuscript/${manuscriptId}/steps`;
  
  const loopCount = repeat ? 100 : 1; 
  const totalSteps = stepsArray.length * loopCount;
  
  console.log(`[VU ${__VU}] Applying ${totalSteps} total batches...`);

  let currentVersion = 0;

  for (let cycle = 0; cycle < loopCount; cycle++) {
      for (let i = 0; i < stepsArray.length; i++) {
        const batch = stepsArray[i];

        const res = http.post(STEPS_URL, JSON.stringify({
            steps: batch.steps,
            version: currentVersion,
            clientID: __VU,
        }), {
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }
        });

        const isOk = check(res, { "Step OK": (r) => r.status === 200 });
        stepSuccess.add(isOk);

        if (isOk) {
            try {
                const body = JSON.parse(res.body);
                currentVersion = body.version || (currentVersion + batch.steps.length);
            } catch (e) {
                currentVersion += batch.steps.length;
            }
        } else {
            console.error(`[VU ${__VU}] Step Failed: ${res.status}`);
            return; 
        }

        const thinkTime = Math.random() * 9 + 1;
        activeWait(token, projectId, manuscriptId, currentVersion, thinkTime);
      }
  }
};


const cleanupSubmission = (submissionId) => {
  const res = http.post(`${BASE_URL}/lw/cleanup/${submissionId}`, null, { headers: { Cookie: "I2BRK=1" } });
  const isOk = check(res, { "Cleanup OK": (r) => r.status === 200 || r.status === 204 });
  cleanupSuccess.add(isOk);

  if (isOk) {
    console.log(`[VU ${__VU}] Cleaned: ${submissionId}`);
  } else {
    console.error(`[FAILED_CLEANUP] ${submissionId}`);
  }
};

function runStressCycle(mode) {
  const jar = http.cookieJar();
  jar.set(BASE_URL, "I2BRK", "1");
  
  let submissionId = null;
  let email = QA_EMAIL;
  let stepsToApply = STEPS_PKG;
  let repeat = false;

  try {
    if (mode === "upload") {
      submissionId = uploadSubmission();
    } else {
      submissionId = createBlankSubmission();
      email = ARTEMIS_EMAIL;
      stepsToApply = STEPS_BLANK;
      repeat = true;
    }

    if (!submissionId) return;

    console.log(`[VU ${__VU}] [${mode}] Start: ${submissionId}`);

    const { projectId, manuscriptId } = pollSubmission(submissionId);
    
    if (!projectId || !manuscriptId) throw new Error("ID Discovery Failed");

    if (mode === "upload") loginWM(email);
    const authToken = loginManuscripts(submissionId);
    if (mode === 'blank') {
      console.log(`[VU ${__VU}] [${mode}] for id: ${submissionId}, repeat blank is: ${REPEAT_BLANK}`);
      console.log(`[VU ${__VU}] [${mode}] for id: ${submissionId}, repeat is: ${repeat}`);
    }

    applySteps(authToken, projectId, manuscriptId, stepsToApply, repeat && REPEAT_BLANK);

  } catch (error) {
    console.error(`[VU ${__VU}] ❌ Error: ${error.message}`);
  } finally {
    if (submissionId) cleanupSubmission(submissionId);
  }
}