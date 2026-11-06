import { test } from "node:test";
import assert from "node:assert/strict";
import { redactUrls, appendOutput, cancelAction, consoleState, dependents, nextJob, trimJobs, type Job, type JobStatus } from "./journal.ts";

const job = (id: number, status: JobStatus, repo = "r"): Job =>
  ({ id, repo, label: `git ${id}`, status, queued: id, start: null, end: null, output: "", error: "", cancelling: false, moved: null });

test("one job at a time per repo, oldest first; repos run independently", () => {
  const jobs = [job(1, "ok"), job(2, "queued"), job(3, "queued"), job(4, "queued", "other")];
  assert.equal(nextJob(jobs, "r")?.id, 2);
  assert.equal(nextJob(jobs, "other")?.id, 4);
  jobs[1].status = "running";
  assert.equal(nextJob(jobs, "r"), undefined, "the next waits for the running one");
  assert.equal(nextJob(jobs, "other")?.id, 4, "another repo is not blocked");
  jobs[1].status = "ok";
  assert.equal(nextJob(jobs, "r")?.id, 3);
  assert.equal(nextJob([job(1, "ok")], "r"), undefined);
});

test("cancel: queued jobs are dropped, a running one is killed once", () => {
  assert.equal(cancelAction(job(1, "queued")), "dequeue");
  const r = job(2, "running");
  assert.equal(cancelAction(r), "kill");
  r.cancelling = true;
  assert.equal(cancelAction(r), null, "already being killed");
  assert.equal(cancelAction(job(3, "ok")), null);
  assert.equal(cancelAction(job(4, "failed")), null);
});

test("a failure ends the repo's queue behind it, not other repos or earlier jobs", () => {
  const jobs = [job(1, "queued"), job(2, "failed"), job(3, "queued"), job(4, "queued", "other"), job(5, "queued")];
  assert.deepEqual(dependents(jobs, jobs[1]).map((j) => j.id), [3, 5]);
});

test("output: \\r redraws the current line, across chunk boundaries", () => {
  let o = "";
  for (const c of ["Receiving objects:  10%\r", "Receiving objects:  55%\rReceiving", " objects: 100%, done.\n", "Resolving: 1\r\nok\n"]) o = appendOutput(o, c);
  assert.equal(o, "Receiving objects: 100%, done.\nResolving: 1\nok\n");
  assert.equal(appendOutput("a\nb", "c\r"), "a\nbc\r", "a pending \\r is kept until the next text");
  assert.equal(appendOutput("a\nbc\r", "X"), "a\nX");
  assert.equal(appendOutput("", "é ü\n"), "é ü\n");
});

test("console button state", () => {
  const ran = (j: Job) => ({ ...j, start: 1 });
  assert.equal(consoleState([], "r"), "idle");
  assert.equal(consoleState([ran(job(1, "ok")), job(2, "queued")], "r"), "running");
  assert.equal(consoleState([ran(job(1, "ok")), ran(job(2, "failed"))], "r"), "failed");
  assert.equal(consoleState([ran(job(1, "failed")), ran(job(2, "ok"))], "r"), "ok");
  assert.equal(consoleState([ran(job(1, "cancelled"))], "r"), "ok", "a killed command is not a failure");
  assert.equal(consoleState([ran(job(1, "failed")), job(2, "cancelled")], "r"), "failed", "commands dropped from the queue never ran");
  assert.equal(consoleState([ran(job(1, "running", "other"))], "r"), "idle", "per repo");
});

test("trim drops the oldest finished jobs only", () => {
  const jobs = [job(1, "ok"), job(2, "running"), job(3, "failed"), job(4, "queued"), job(5, "ok")];
  assert.deepEqual(trimJobs(jobs, 3).map((j) => j.id), [2, 4, 5]);
  assert.equal(trimJobs(jobs, 10), jobs);
});

test("URL passwords never reach the console", () => {
  assert.equal(redactUrls("git remote add o https://bob:s3cr3t@example.com/r.git"), "git remote add o https://bob:***@example.com/r.git");
  assert.equal(redactUrls("git remote add o https://bob@example.com/r.git git@host:x.git ssh://git@h:22/x"), "git remote add o https://bob@example.com/r.git git@host:x.git ssh://git@h:22/x");
});
