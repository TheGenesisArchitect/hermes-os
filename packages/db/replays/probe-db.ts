// Quick DB census for the deployer-edge harness: is there enough data?
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";

(async () => {
    const q = postgres(url, { idle_timeout: 5 });
    const [td] = await q`select count(*)::int n, count(distinct deployer)::int deployers from token_deployers`;
    const [co] = await q`select count(*)::int n, count(*) filter (where label='winner')::int winners, count(*) filter (where label='rug')::int rugs, count(*) filter (where label='open')::int open from candidate_outcomes`;
    const [pos] = await q`select lane, count(*)::int n from positions group by lane order by lane`;
    const [joined] = await q`select count(*)::int n from token_deployers d join candidate_outcomes co on co.mint=d.mint where co.label in ('winner','rug')`;
    console.log("token_deployers:", JSON.stringify(td));
    console.log("candidate_outcomes:", JSON.stringify(co));
    console.log("positions by lane:", JSON.stringify(pos));
    console.log("deployers joined to labeled outcomes:", JSON.stringify(joined));
    await q.end();
})();
