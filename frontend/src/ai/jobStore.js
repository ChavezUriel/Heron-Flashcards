// Where generation runs live between page loads.
//
// Runs are driven by the browser tab, so their home is the browser too: no
// migration, no service key, no server-side job queue. The status page reads
// from here on mount, and the runner writes back after every card — reloading
// mid-run costs at most the card in flight, and the run can be resumed.
//
// Only the most recent runs are kept, and a job's card payload is the bulk of
// it, so the store prunes oldest-first when storage fills up.

const STORAGE_KEY = 'heron.aiDeckJobs';
const MAX_JOBS = 6;

function readAll() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(jobs) {
  // Newest first, capped — a long-lived install shouldn't grow without bound.
  const ordered = [...jobs]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, MAX_JOBS);
  for (let attempt = 0; attempt < MAX_JOBS; attempt += 1) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ordered.slice(0, ordered.length - attempt)));
      return;
    } catch {
      // Quota: drop the oldest run and try again.
      if (ordered.length - attempt <= 1) return;
    }
  }
}

export function listJobs() {
  return readAll().sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export function getJob(jobId) {
  return readAll().find((job) => job.id === jobId) ?? null;
}

export function saveJob(job) {
  const jobs = readAll().filter((stored) => stored.id !== job.id);
  jobs.push(job);
  write(jobs);
  return job;
}

export function deleteJob(jobId) {
  write(readAll().filter((job) => job.id !== jobId));
}

// A run that was still 'running' when the page went away cannot have survived —
// the tab that drove it is gone. Mark those interrupted on load so the status
// page offers Resume instead of pretending work is happening.
export function reconcileInterruptedJobs() {
  const jobs = readAll();
  let changed = false;
  for (const job of jobs) {
    if (job.status === 'running') {
      job.status = 'interrupted';
      job.log = [
        ...(job.log ?? []),
        {
          id: `${Date.now()}-interrupted`,
          at: new Date().toISOString(),
          level: 'warn',
          message: 'The page closed while this run was working — resume to continue where it stopped.',
        },
      ];
      changed = true;
    }
  }
  if (changed) write(jobs);
  return jobs;
}
