export class AppError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, `Route topilmadi: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(error, _req, res, _next) {
  const statusCode = error.statusCode || 500;
  const message = error.message || 'Server error';

  if (statusCode >= 500) {
    console.error('[backend:error]', error);
  }

  res.status(statusCode).json({
    ok: false,
    message,
    details: error.details || undefined,
  });
}
