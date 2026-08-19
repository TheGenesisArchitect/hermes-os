// Derive the OmniRoute CLI machine token exactly as the app does, using the
// container's node-machine-id, so we can authenticate the loopback CLI path.
const { createHash, createHmac } = require("crypto");
let machineIdSync;
try {
    const mod = require("node-machine-id");
    machineIdSync = mod.machineIdSync || mod.default?.machineIdSync;
} catch (e) {
    console.log("NO node-machine-id:", e.message);
    process.exit(1);
}
const salt = process.env.OMNIROUTE_CLI_SALT || "omniroute-cli-auth-v1";
const rawId = machineIdSync(true);
const machineToken = createHmac("sha256", rawId).update(salt).digest("hex");
const legacy = createHash("sha256").update(machineIdSync() + salt).digest("hex").substring(0, 32);
console.log(JSON.stringify({ machineToken, legacy }));
