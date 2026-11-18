/**
 * What heel logs about an error on the decision path: class names and codes
 * along the cause chain, never a message. Messages can carry call arguments
 * (a failed SQL statement's message lists its parameters), and the error log
 * never includes argument values (spec: Fail-closed behavior).
 */
export interface ErrorShape {
  name: string;
  code?: string | number;
  cause?: ErrorShape;
}

const MAX_CAUSE_DEPTH = 5;

export function errorShape(error: unknown, depth = 0): ErrorShape {
  if (!(error instanceof Error)) return { name: typeof error };
  const code = "code" in error ? error.code : undefined;
  const shape: ErrorShape = {
    name: error.name,
    ...((typeof code === "string" || typeof code === "number") && { code }),
  };
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    shape.cause = errorShape(error.cause, depth + 1);
  }
  return shape;
}
