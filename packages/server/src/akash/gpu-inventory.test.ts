import { describe, expect, it } from 'vitest';
import type { GpuModelOption, GpuSpec } from '@shared/types';
import { buildMultiGroupGpuCandidates, isDatacenterClassGpu } from './gpu-inventory';

function opt(model: string, available: number, vendor: 'nvidia' | 'amd' = 'nvidia'): GpuModelOption {
  return { vendor, model, ram: null, interface: null, allocatable: available, allocated: 0, available };
}

describe('isDatacenterClassGpu', () => {
  it('accepts hopper/ada/datacenter models and rejects consumer cards', () => {
    expect(isDatacenterClassGpu('h100')).toBe(true);
    expect(isDatacenterClassGpu('A100')).toBe(true); // case-insensitive
    expect(isDatacenterClassGpu('rtx3060')).toBe(false);
    expect(isDatacenterClassGpu('t4')).toBe(false);
  });
});

describe('buildMultiGroupGpuCandidates', () => {
  const requested: GpuSpec = { vendor: 'nvidia', model: 'a100' };

  it('puts the requested GPU first, then datacenter alternates in JOB_GPU_PREFERENCE order', () => {
    const available = [opt('l40', 3), opt('h100', 2), opt('a100', 1)];
    const result = buildMultiGroupGpuCandidates(available, requested);
    expect(result.map((c) => c.model)).toEqual(['a100', 'h100', 'l40']);
  });

  it('never repeats the requested model among the alternates', () => {
    const available = [opt('a100', 5), opt('h100', 2)];
    const result = buildMultiGroupGpuCandidates(available, requested);
    expect(result.filter((c) => c.model === 'a100')).toHaveLength(1);
  });

  it('excludes non-datacenter-class models', () => {
    const available = [opt('h100', 2), opt('rtx3060', 9), opt('t4', 4)];
    const result = buildMultiGroupGpuCandidates(available, requested);
    expect(result.map((c) => c.model)).toEqual(['a100', 'h100']);
  });

  it('excludes models with no free capacity', () => {
    const available = [opt('h100', 0), opt('l40', 2)];
    const result = buildMultiGroupGpuCandidates(available, requested);
    expect(result.map((c) => c.model)).toEqual(['a100', 'l40']);
  });

  it('caps the total number of groups at maxGroups (requested counts as one)', () => {
    const available = [opt('h100', 2), opt('l40', 2), opt('l4', 2), opt('h200', 2)];
    const result = buildMultiGroupGpuCandidates(available, requested, 2);
    expect(result).toHaveLength(2);
    expect(result[0]!.model).toBe('a100'); // requested kept
  });

  it("carries the requested GPU's unit count onto every alternate", () => {
    const multi: GpuSpec = { vendor: 'nvidia', model: 'a100', units: 2 };
    const available = [opt('h100', 2)];
    const result = buildMultiGroupGpuCandidates(available, multi);
    expect(result.every((c) => c.units === 2)).toBe(true);
  });

  it('returns just the requested GPU when no datacenter alternates are available', () => {
    const result = buildMultiGroupGpuCandidates([], requested);
    expect(result).toEqual([{ vendor: 'nvidia', model: 'a100' }]);
  });
});
