import fs from "node:fs/promises";
import { getPackageAdapter, comparePackages } from "./analyzer.mjs";
const [jobFile, outputFile] = process.argv.slice(2);
try {
  const job = JSON.parse(await fs.readFile(jobFile, "utf8"));
  const adapter = getPackageAdapter(job.format || "hap");
  const baseline = adapter.read(
    await fs.readFile(job.baselinePath),
    job.limits,
  );
  if (job.mode === "inspect") {
    await fs.writeFile(
      outputFile,
      JSON.stringify({
        metadata: baseline.metadata,
        size: baseline.size,
        sha256: baseline.sha256,
      }),
    );
  } else {
    const current = getPackageAdapter(
      job.currentFormat || job.format || "hap",
    ).read(await fs.readFile(job.currentPath), job.limits);
    if (
      baseline.sha256 !== job.baselineHash ||
      current.sha256 !== job.currentHash
    )
      throw new Error("产物校验值发生变化，拒绝复用输入");
    await fs.writeFile(
      outputFile,
      JSON.stringify(comparePackages(baseline, current, job.input)),
    );
  }
} catch (error) {
  await fs.writeFile(
    outputFile,
    JSON.stringify({
      error: error instanceof Error ? error.message : "解析失败",
    }),
  );
  process.exitCode = 1;
}
