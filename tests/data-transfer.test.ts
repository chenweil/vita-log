import { describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import { exportCsv, exportJson, importJsonPreview, importCsvPreview } from '../src/data-transfer';

const NOW = '2026-10-03T00:00:00.000Z';

describe('backup and import transfer', () => {
  it('round-trips the complete snapshot through JSON', () => {
    const snapshot = createEmptySnapshot(NOW);
    snapshot.settings.name = 'Along';
    snapshot.weights.push({ id: 'w1', date: '2026-10-03', weightKg: 77, note: '', createdAt: NOW, updatedAt: NOW });

    const preview = importJsonPreview(exportJson(snapshot), snapshot);

    expect(preview.valid).toBe(true);
    expect(preview.snapshot?.settings.name).toBe('Along');
    expect(preview.snapshot?.weights[0].id).toBe('w1');
  });

  it('exports fixed CSV columns for every supported record kind', () => {
    const snapshot = createEmptySnapshot(NOW);
    snapshot.diets.push({ id: 'd1', date: '2026-10-03', meal: '午餐', food: '鸡胸肉', calorie: 200, protein: 35, fat: 4, carb: 2, sodium: 200, note: '', createdAt: NOW, updatedAt: NOW });

    expect(exportCsv(snapshot, 'diet')).toContain('日期,餐次,食物,热量(kcal),蛋白质(g),脂肪(g),碳水(g),钠(mg),备注');
    expect(exportCsv(snapshot, 'diet')).toContain('2026-10-03,午餐,鸡胸肉,200,35,4,2,200');
  });

  it('previews CSV errors and duplicate conflicts without changing the source snapshot', () => {
    const snapshot = createEmptySnapshot(NOW);
    snapshot.weights.push({ id: 'w1', date: '2026-10-03', weightKg: 77, note: '', createdAt: NOW, updatedAt: NOW });
    const csv = '日期,体重(kg),体脂率(%),备注\n2026-10-03,76.5,,冲突\n2026-10-04,76.2,,新记录\n错误日期,75,,错误';

    const preview = importCsvPreview(snapshot, 'weight', csv, NOW);

    expect(preview.valid).toBe(false);
    expect(preview.conflicts).toBe(1);
    expect(preview.accepted).toBe(1);
    expect(preview.errors).toHaveLength(1);
    expect(preview.details[0]).toContain('第 2 行');
    expect(snapshot.weights).toHaveLength(1);
    expect(preview.snapshot?.weights).toHaveLength(2);
  });

  it('rejects a header-only CSV with a clear error', () => {
    const preview = importCsvPreview(createEmptySnapshot(NOW), 'diet', '日期,餐次,食物,热量(kcal),蛋白质(g),脂肪(g),碳水(g),钠(mg),备注', NOW);

    expect(preview).toMatchObject({ valid: false, errors: ['CSV 文件没有数据行'] });
  });
});
