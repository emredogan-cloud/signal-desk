import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { trends, trendObservations } from '../schema.js';

/**
 * Trend persistence.
 *
 * The human fields are stored as supplied and NEVER written by the system. A
 * fabricated mechanism — "this format works because it rewards curiosity" — reads
 * exactly like a real one, and once stored it is indistinguishable from something the
 * operator actually observed.
 */

export type NewTrend = {
  readonly name: string;
  readonly platform: string;
  readonly mechanism: string | undefined;
  readonly howToParticipate: string | undefined;
  readonly originalVersion: string | undefined;
};

export function upsertTrend(db: Db, input: NewTrend, now: Date): number {
  const existing = db
    .select({ id: trends.id })
    .from(trends)
    .where(eq(trends.name, input.name))
    .get();

  if (existing !== undefined) {
    db.update(trends)
      .set({
        platform: input.platform,
        // Only overwrite a human field when a new value was actually supplied —
        // an omitted field must not blank out what the operator entered earlier.
        ...(input.mechanism === undefined ? {} : { mechanism: input.mechanism }),
        ...(input.howToParticipate === undefined
          ? {}
          : { howToParticipate: input.howToParticipate }),
        ...(input.originalVersion === undefined ? {} : { originalVersion: input.originalVersion }),
        updatedAt: now,
      })
      .where(eq(trends.id, existing.id))
      .run();
    return existing.id;
  }

  const inserted = db
    .insert(trends)
    .values({
      name: input.name,
      platform: input.platform,
      mechanism: input.mechanism ?? null,
      howToParticipate: input.howToParticipate ?? null,
      originalVersion: input.originalVersion ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: trends.id })
    .get();

  return inserted.id;
}

export function addObservation(
  db: Db,
  input: {
    trendId: number;
    observedAt: Date;
    mentionCount: number;
    distinctSources: number;
    manual: boolean;
    note: string;
  },
): void {
  db.insert(trendObservations).values(input).run();
}

export function observationsFor(db: Db, trendId: number) {
  return db
    .select()
    .from(trendObservations)
    .where(eq(trendObservations.trendId, trendId))
    .orderBy(trendObservations.observedAt)
    .all();
}

export function allTrends(db: Db) {
  return db.select().from(trends).orderBy(trends.name).all();
}

export function updatePlacement(
  db: Db,
  trendId: number,
  placement: { stage: string; saturation: number; explanation: string },
  now: Date,
): void {
  db.update(trends)
    .set({
      stage: placement.stage,
      saturation: placement.saturation,
      stageExplanation: placement.explanation,
      updatedAt: now,
    })
    .where(eq(trends.id, trendId))
    .run();
}

export function countTrends(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(trends)
      .get()?.n ?? 0
  );
}
