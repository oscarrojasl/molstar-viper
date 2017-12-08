import * as B from 'benchmark'
import now from 'mol-task/util/now'
import Immedite from 'mol-task/util/immediate'

export namespace Tasks {
    export class Yielding {
        lastUpdated = 0;
        yield(): Promise<void> | void {
            const t = now();
            if (t - this.lastUpdated < 250) return;
            this.lastUpdated = t;
            return Immedite.immediatePromise();
        }
    }

    export class CheckYielding {
        lastUpdated = 0;

        get needsYield() {
            return now() - this.lastUpdated > 250;
        }

        yield(): Promise<void> {
            this.lastUpdated = now();
            return Immedite.immediatePromise();
        }
    }

    export async function yielding() {
        console.time('yielding');
        const y = new Yielding();
        let ret = 0;
        for (let i = 0; i < 1000000; i++) {
            ret += +(i.toString() + i.toString());
            if (i % 10000 === 0) await y.yield();
        }
        console.timeEnd('yielding');
        console.log(ret);
        return ret;
    }

    export async function yielding1() {
        console.time('yielding1');
        const y = new Yielding();
        let ret = 0;
        let yy: any;
        for (let i = 0; i < 1000000; i++) {
            ret += +(i.toString() + i.toString());
            if (i % 10000 === 0 && (yy = y.yield())) await yy;
        }
        console.timeEnd('yielding1');
        console.log(ret);
        return ret;
    }

    export async function testYielding() {
        console.time('check yielding');
        const y = new CheckYielding();
        let ret = 0;
        for (let i = 0; i < 1000000; i++) {
            ret += +(i.toString() + i.toString());
            if (i % 10000 === 0 && y.needsYield) await y.yield();
        }
        console.timeEnd('check yielding');
        console.log(ret);
        return ret;
    }

    export async function baseline() {
        console.time('baseline');
        let ret = 0;
        for (let i = 0; i < 1000000; i++) {
            ret += +(i.toString() + i.toString());
        }
        console.timeEnd('baseline');
        console.log(ret);
        return ret;
    }

    export async function testImmediate() {
        console.time('immediate');
        let ret = 0;
        const y = new CheckYielding();
        for (let i = 0; i < 1000000; i++) {
            //ret += +(i.toString() + i.toString());
            if (i % 10000 === 0) await y.yield();
        }
        console.timeEnd('immediate');
        console.log(ret);
        return ret;
    }

    export function run() {
        const suite = new B.Suite();
        suite
            .add(`yielding`, async () => { return await yielding() })
            //.add(`test yielding`, () => testYielding().then(() => { }))
            .on('cycle', (e: any) => console.log(String(e.target)))
            .run();
    }
}

(async function() {
    // await Tasks.testImmediate();
    // await Tasks.testImmediate();

    await Tasks.baseline();
    await Tasks.yielding();
    await Tasks.yielding1();
    await Tasks.testYielding();
    await Tasks.baseline();
    await Tasks.yielding();
    await Tasks.yielding1();
    await Tasks.testYielding();
}())

// console.time('test')
// Tasks.yielding();
// console.timeEnd('test')
// console.time('test')
// Tasks.yielding();
// console.timeEnd('test')

// console.time('test')
// Tasks.testYielding();
// console.timeEnd('test')
// console.time('test')
// Tasks.testYielding();
// console.timeEnd('test')