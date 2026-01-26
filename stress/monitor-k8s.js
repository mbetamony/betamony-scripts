const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const NAMESPACE = "dev1";
const APP_LABEL = "app=api";
const INTERVAL_MS = 2000;
const OUTPUT_DIR = "./stress_test_results";

const files = {
  pods: path.join(OUTPUT_DIR, "k8s-pods.csv"),
  nodes: path.join(OUTPUT_DIR, "k8s-nodes.csv"),
  events: path.join(OUTPUT_DIR, "k8s-events.log"),
};

const now = () => new Date().toISOString();

const ensureEnv = () => {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (!fs.existsSync(files.pods))
    fs.writeFileSync(files.pods, "Timestamp,PodName,CPU(m),Memory(Mi)\n");

  if (!fs.existsSync(files.nodes))
    fs.writeFileSync(files.nodes, "Timestamp,NodeName,CPU%,Memory%\n");
};

const runCommand = (cmd) => {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        console.warn(
          `[${now()}] ⚠️ cmd failed: ${cmd} (${error.message.trim()})`,
        );
        resolve("");
      } else {
        resolve(stdout.trim());
      }
    });
  });
};


const monitorPods = async () => {
  const output = await runCommand(
    `kubectl top pod -n ${NAMESPACE} -l ${APP_LABEL} --no-headers`,
  );
  if (!output) return;

  const entries = [];
  output.split("\n").forEach((line) => {
    if (!line.trim()) return;
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3) {
      const [name, cpu, mem] = parts;
      entries.push(`${now()},${name},${cpu},${mem}`);
    }
  });

  if (entries.length > 0) {
    fs.appendFileSync(files.pods, entries.join("\n") + "\n");
    console.log(`[${now()}] Logged ${entries.length} pods`);
  }
};

const monitorNodes = async () => {
  const output = await runCommand(`kubectl top nodes --no-headers`);
  if (!output) return;

  const entries = [];
  output.split("\n").forEach((line) => {
    if (!line.trim()) return;
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5) {
      const name = parts[0];
      if (name.includes("dev")){
        const cpuPercent = parts[2];
        const memPercent = parts[4];
        entries.push(`${now()},${name},${cpuPercent},${memPercent}`);
      }
    }
  });

  if (entries.length > 0)
    fs.appendFileSync(files.nodes, entries.join("\n") + "\n");
};

const monitorRestarts = async () => {
  const output = await runCommand(
    `kubectl get pods -n ${NAMESPACE} -l ${APP_LABEL} --no-headers`,
  );

  if (!output) return;

  output.split("\n").forEach((line) => {
    if (!line.trim()) return;

    const parts = line.trim().split(/\s+/);

    if (parts.length < 4) return;

    const name = parts[0];
    const status = parts[2];
    const restarts = parseInt(parts[3], 10);

    if (!isNaN(restarts) && (restarts > 0 || status !== "Running")) {
      const eventMsg = `[${now()}] WARNING: Pod ${name} is ${status} with ${restarts} restarts\n`;
      fs.appendFileSync(files.events, eventMsg);
    }
  });
};

const tick = async () => {
  await Promise.all([monitorPods(), monitorNodes(), monitorRestarts()]);

  setTimeout(tick, INTERVAL_MS);
};

const start = () => {
  ensureEnv();
  console.log(`Monitoring Namespace: ${NAMESPACE} | Label: ${APP_LABEL}`);
  console.log(`Output: ${OUTPUT_DIR}`);

  tick();
};

start();
