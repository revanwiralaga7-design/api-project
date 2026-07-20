/**
 * Membungkus async route handler supaya error otomatis diteruskan ke
 * Express error middleware (tidak perlu try/catch berulang di tiap route).
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
