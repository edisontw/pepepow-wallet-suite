import { disableAllDcaConfigsGlobal } from "../db.js";

const stopped = disableAllDcaConfigsGlobal();
console.log(`[cleanup] stopped DCA configs: ${stopped}`);
