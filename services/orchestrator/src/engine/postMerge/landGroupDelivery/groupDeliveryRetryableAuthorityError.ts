/** Fresh authority failed before a provider call and the owned intent was safely retracted. */
export class LandGroupDeliveryRetryableAuthorityError extends Error {
  public override readonly name = "LandGroupDeliveryRetryableAuthorityError";
  public constructor(step: "preview" | "promote", cause: unknown) {
    super(`land-group delivery ${step} authority was unavailable before provider invocation`, { cause });
  }
}
