export function notFound(req, res, next) {
  res.status(404).json({
    status: false,
    error: `Route tidak ditemukan: ${req.method} ${req.originalUrl}`
  });
}

export default notFound;
