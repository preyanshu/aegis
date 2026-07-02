import { startMpcNodeService } from "../services/mpc/node-service.js";

startMpcNodeService().catch((error) => {
  console.error("Failed to start MPC node service:", error);
  process.exit(1);
});
