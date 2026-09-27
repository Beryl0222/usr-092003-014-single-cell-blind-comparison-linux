"use strict";

const { SERVICE_ID, SERVICE_NAME, healthPayload, createApp, defaultTokens } = require("./src/app");

function createServer(options) {
  return createApp(options);
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== SERVICE_ID) throw new Error("服务身份不一致");
    const probe = createApp({ tokens: defaultTokens() });
    if (typeof probe.listen !== "function") throw new Error("应用创建失败");
    process.stdout.write("基础检查通过\n");
  } else {
    const port = Number(process.env.PORT || 8000);
    createServer().listen(port, "127.0.0.1");
  }
}

module.exports = { SERVICE_ID, SERVICE_NAME, createServer, healthPayload };
