// queue.js
// Background job queue (Phase 1, item #2).
//
// Why this exists: a Gemini analysis call over a full multi-exhibit RFP can
// take a long time. Doing that inside the HTTP request handler means the
// request stays open the whole time — one slow analysis blocks that
// connection, browser/proxy timeouts become a real risk, and there's no way
// to show "your analysis is #2 in line" or let the user navigate away and
// come back. Moving the actual work into a BullMQ queue (backed by Redis)
// means /api/analyze-merged just enqueues the job and returns instantly;
// a worker (started in this same process) does the slow part separately.
//
// Requires a Redis server running and reachable at REDIS_URL (defaults to
// localhost:6379). Install Redis locally (e.g. `apt install redis-server`,
// `brew install redis`, or run the official Docker image) and make sure
// it's running before starting this backend.

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_NAME = 'rfp-analysis';

// BullMQ requires this exact option on the connection it's given.
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

let redisReady = false;
connection.on('connect', () => {
  redisReady = true;
  console.log(`[queue] Connected to Redis at ${REDIS_URL}`);
});
connection.on('error', (err) => {
  if (redisReady) {
    console.error('[queue] Redis connection error:', err.message);
  } else {
    console.error(`\n[FATAL] Could not connect to Redis at ${REDIS_URL}.`);
    console.error('The background job queue (BullMQ) requires Redis to be installed and running.');
    console.error('Start it (e.g. `redis-server`) or set REDIS_URL in .env, then restart this backend.\n');
  }
});

const analysisQueue = new Queue(QUEUE_NAME, { connection });

// `processJob(job.data)` is supplied by server.js — it's the actual
// "call Gemini + apply deterministic checks" logic, kept in server.js so
// the prompt-building functions don't have to be duplicated or exported
// across files. This module just wires that logic up to a BullMQ Worker.
function startWorker(processJob) {
  const worker = new Worker(QUEUE_NAME, async (job) => {
    return processJob(job.data, job);
  }, {
    connection,
    concurrency: Number(process.env.ANALYSIS_CONCURRENCY || 2)
  });

  worker.on('failed', (job, err) => {
    console.error(`[queue] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

async function enqueueAnalysis(jobId, payload) {
  await analysisQueue.add('analyze', payload, {
    jobId,
    removeOnComplete: { age: 3600 },   // keep completed jobs in Redis for 1hr (debugging), DB is source of truth
    removeOnFail: { age: 86400 }
  });
}

module.exports = { analysisQueue, startWorker, enqueueAnalysis };
