import app from "./src/app.js";
import { config } from "./src/config/index.js";

app.listen(config.port, () => {
  console.log(`🚀 Server berjalan di http://localhost:${config.port}`);
  console.log(`📚 Daftar endpoint: http://localhost:${config.port}/api/endpoints`);
});
