/**
 * Format response sukses yang konsisten di seluruh endpoint.
 */
export function ok(res, result, extra = {}, status = 200) {
  return res.status(status).json({
    status: true,
    ...extra,
    result
  });
}

/**
 * Error kustom dengan status code HTTP, dipakai service/route
 * lalu ditangkap oleh error middleware.
 */
export class ApiError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function fail(res, message, status = 500) {
  return res.status(status).json({
    status: false,
    error: message
  });
}
