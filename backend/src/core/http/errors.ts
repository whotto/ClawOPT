export type StructuredMessageParams = Record<string, string | number | boolean | null>;

export function buildStructuredApiError(
  errorCode: string,
  errorDetail?: string | null,
  errorParams?: StructuredMessageParams | null
) {
  return {
    success: false as const,
    errorCode,
    errorParams: errorParams || null,
    errorDetail: typeof errorDetail === 'string' && errorDetail.trim() ? errorDetail.trim() : null,
  };
}

export class StructuredRequestError extends Error {
  status: number;
  payload: ReturnType<typeof buildStructuredApiError>;

  constructor(
    status: number,
    errorCode: string,
    errorDetail?: string | null,
    errorParams?: StructuredMessageParams | null
  ) {
    super(errorDetail || errorCode);
    this.status = status;
    this.payload = buildStructuredApiError(errorCode, errorDetail, errorParams);
  }
}

export function isStructuredRequestError(error: unknown): error is StructuredRequestError {
  return error instanceof StructuredRequestError;
}
