import { normalizeSnapshot, type HealthSnapshot } from './domain';

export interface SnapshotValidationResult {
  valid: boolean;
  snapshot?: HealthSnapshot;
  errors: string[];
}

export function validateSnapshotPayload(payload: unknown): SnapshotValidationResult {
  try {
    return { valid: true, snapshot: normalizeSnapshot(payload), errors: [] };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : '备份数据校验失败'] };
  }
}

export function parseSnapshotJson(text: string): SnapshotValidationResult {
  try {
    return validateSnapshotPayload(JSON.parse(text) as unknown);
  } catch {
    return { valid: false, errors: ['备份文件不是有效 JSON'] };
  }
}
