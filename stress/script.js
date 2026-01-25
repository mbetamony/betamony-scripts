const fs = require("fs");

const blank = JSON.parse(fs.readFileSync("recorded_steps_blank.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("recorded_steps_pkg.json", "utf8"));


console.log(blank.length)
console.log(pkg.length)