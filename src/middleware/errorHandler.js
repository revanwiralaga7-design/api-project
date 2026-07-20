import { config } from "../config/index.js";

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  const message = err.message || "Internal Server Error";

  if (config.nodeEnv !== "test") {
    console.error(`[ERROR] ${req.method} ${req.originalUrl} -> ${message}`);
    if (config.nodeEnv === "development" && err.stack) console.error(err.stack);
  }

  res.status(status).json({
    status: false,
    error: message,
  });
}

export default errorHandler;
