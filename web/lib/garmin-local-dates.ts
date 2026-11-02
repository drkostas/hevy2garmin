import type { GarminGateway } from "hevy2garmin";

function offsetDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/**
 * Garmin filters its activity list by the recording's LOCAL calendar date.
 * The engine builds search dates from Hevy's UTC timestamps. Include the
 * adjacent dates so an evening session in the Americas (or an early session
 * east of UTC) is visible. Matching still checks the original UTC timestamps,
 * activity type, overlap and drift; this only widens the listing, not eligibility.
 */
export function withGarminLocalDates(gateway: GarminGateway): GarminGateway {
  return {
    ...gateway,
    activitiesByDate: (start, end) =>
      gateway.activitiesByDate(offsetDay(start, -1), offsetDay(end, 1)),
  };
}
