
import async_hooks, { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import http from 'http';

type TaskInfo = {
    asyncId: number,
    triggerAsyncId: number,
    startedAt: string,
    eventLoopId?: number,
    eventLoopTime: number,
    beforeTime?: number,
    afterTime?: number,
};

type TaskStats = {
    requestDuration: number;
    ratio: number;
    min: number;
    max: number;
    duration: number;
    startId: number;
    endId: number;
    slows: TaskInfo[];
}

type RequestStore = {
    buffer: string[];
    taskMap: Map<number, TaskInfo>;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestStore>();
const asyncHook = async_hooks.createHook({ init, before, after, promiseResolve });

let count = 0;
let eventLoopId = 0;

const app = express();
app.get('/', function (req, res, next) {
    const start = performance.now();
    
    const buffer: string[] = [];
    const taskMap = new Map<number, TaskInfo>();
    const store: RequestStore = { buffer, taskMap };
    asyncLocalStorage.run(store, () => {
        count += 1;
        asyncHook.enable();
        setTimeout(() => {
            const startId = eventLoopId;
            myFunc().then(() => {
                count -= 1;
                if (count === 0) {
                    asyncHook.disable();
                }
                const endId = eventLoopId;
                const stats = computeStats(taskMap, start, performance.now(), startId, endId);
                printTasks(buffer, taskMap, stats);
                return res.send(stats);
            }).catch(err => {
                return next(err);
            });
        });
    });
});
app.get('/slow', function (req, res, next) {
    sleep(10000).then(() => res.send('OK'));
});
app.get('/test', function (req, res, next) {
    slowRequest().then((data) => res.send(data));
});
app.listen(3000);

measureLag();

function measureLag() {
    eventLoopId += 1;
    const start = performance.now();
    setTimeout(() => {
        const duration = performance.now() - start;
        if (duration > 100) {
            console.error(`[LAG] ${eventLoopId}: ${duration}`);
        }
        measureLag();
    });
}


function printTasks(
    buffer: string[],
    taskMap: Map<number, TaskInfo>,
    stats: TaskStats,
): void {
    // debug
    buffer.forEach(b => console.log(b));
    console.log();
    console.log();

    // tasks
    taskMap.forEach((task) => {
        console.log(JSON.stringify(task));
    });

    // stats
    console.log();
    console.log();
    console.log(JSON.stringify(stats, null, 2));
}

function computeStats(taskMap: Map<number, TaskInfo>, start: number, end: number, startId: number, endId: number): TaskStats {
    const all = Array.from(taskMap.values()).filter(t => t.eventLoopTime > 0);
    const stats = all.reduce((stats, t) => {
        stats.min = Math.min(stats.min, t.eventLoopTime);
        stats.max = Math.max(stats.max, t.eventLoopTime);
        stats.duration += t.eventLoopTime;
        stats.ratio = stats.duration / stats.requestDuration;
        if (t.eventLoopTime > 100) {
            stats.slows.push(t);
        }
        return stats;
    }, {
        requestDuration: end - start,
        startId,
        endId,
        min: Number.MAX_SAFE_INTEGER,
        max: 0,
        duration: 0,
        ratio: 1,
        slows: [],
    } as TaskStats);
    stats.slows.sort((a, b) => b.eventLoopTime - a.eventLoopTime);
    return stats;
}

async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function slowRequest() {
    return new Promise<string>((res, rej) => {
        http.get('http://localhost:3000/slow', (resp) => {
            let data = '';
            resp.on('data', (chunk) => {
                data += chunk;
            });
            resp.on('end', () => {
                res(data);
            });
        }).on("error", (err) => rej(err));
    })
}

async function myFunc() {
    const { buffer } = asyncLocalStorage.getStore();
    buffer.push(`myFunc: ${async_hooks.executionAsyncId()} / ${async_hooks.triggerAsyncId()}`);
    cpuTaskSync();
    await ioTask();
    await cpuTask();
    await ioTask();
    await cpuTask();
    await ioTask();
    await slowRequest();
}

async function ioTask() {
    const { buffer } = asyncLocalStorage.getStore();
    buffer.push(`ioTask: ${async_hooks.executionAsyncId()} / ${async_hooks.triggerAsyncId()}`);
    const start = performance.now();
    await sleep(2000);
    buffer.push(`${performance.now() - start}`);
}

async function cpuTask() {
    const { buffer } = asyncLocalStorage.getStore();
    buffer.push(`cpuTask: ${async_hooks.executionAsyncId()} / ${async_hooks.triggerAsyncId()}`);
    const start = performance.now();
    let sum = 0;
    for (let i = 0; i < 1_000_000_000; i++) {
        sum += 1;
    }
    buffer.push(`${performance.now() - start}`);
}

function cpuTaskSync() {
    const { buffer } = asyncLocalStorage.getStore();
    buffer.push(`cpuTaskSync: ${async_hooks.executionAsyncId()} / ${async_hooks.triggerAsyncId()}`);
    const start = performance.now();
    let sum = 0;
    for (let i = 0; i < 3_000_000_000; i++) {
        sum += 1;
    }
    buffer.push(`${performance.now() - start}`);
}

function init(asyncId, type, triggerAsyncId, resource) {
    const startedAt = extractStartedAt(new Error().stack);
    const { buffer, taskMap } = asyncLocalStorage.getStore() ?? {};
    buffer?.push(`init: ${asyncId} / ${type} / ${triggerAsyncId} / ${typeof resource} / ${startedAt}`);
    taskMap?.set(asyncId, {
        asyncId,
        triggerAsyncId,
        startedAt,
        eventLoopTime: 0,
    });
}

function extractStartedAt(stack: string) {
    const lines = stack.split('\n');
    for (const l of lines) {
        if (l.includes(__dirname)
            && !l.includes('at AsyncHook')) {
            return l.replaceAll(/\s+at /g, '');
        }
    }
    return '<unknown>';
}

function before(asyncId) {
    const { buffer, taskMap } = asyncLocalStorage.getStore() ?? {};
    buffer?.push(`before: ${asyncId}`);
    const task = taskMap?.get(asyncId);
    if (task) {
        task.beforeTime = performance.now();
        task.eventLoopId = eventLoopId;
        updateTask(task);
    }
}

function after(asyncId) {
    const { buffer, taskMap } = asyncLocalStorage.getStore() ?? {};
    buffer?.push(`after: ${asyncId}`);
    const task = taskMap?.get(asyncId);
    if (task) {
        task.afterTime = performance.now();
        updateTask(task);
    }
}

function promiseResolve(asyncId) {
    const { buffer } = asyncLocalStorage.getStore() ?? {};
    buffer?.push(`promiseResolve: ${asyncId}`);
}

function updateTask(task: TaskInfo): TaskInfo {
    if (task.beforeTime && task.afterTime) {
        task.eventLoopTime = task.afterTime - task.beforeTime;
    }
    return task;
}
