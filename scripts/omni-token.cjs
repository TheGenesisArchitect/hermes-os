// Print the OmniRoute CLI machine token (loopback-only auth path) by reusing the
// app's own machineToken module logic where possible. Falls back to reading the
// machine id + hashing if the module isn't directly requireable.
const path = "/app/src/lib/machineToken.ts";
const fs = require("fs");
console.log("=== machineToken.ts source ===");
try {
    console.log(fs.readFileSync(path, "utf8"));
} catch (e) {
    console.log("cannot read", path, e.message);
}
