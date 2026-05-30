import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { buildSdlString, type BuildSdlArgs } from './sdl';
import type { GpuSpec } from '@shared/types';

const base: BuildSdlArgs = {
  functionId: 'fn-1',
  initialVersionId: 'v-1',
  runnerToken: 'tok',
  resources: { cpu: '2', memory: '4Gi', storage: '10Gi' },
  executionKind: 'job',
  deploymentId: 'dep-1',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (s: string): any => yaml.load(s);

describe('buildSdlString — single-group (unchanged shape)', () => {
  it('emits today’s single-group shape when no gpuGroups: one `dcloud` group, uact pricing', () => {
    const s = parse(
      buildSdlString({ ...base, resources: { ...base.resources, gpu: { vendor: 'nvidia', model: 'a100' } } }, 'img:1')
    );
    expect(Object.keys(s.services)).toEqual(['fn']);
    expect(Object.keys(s.deployment.fn)).toEqual(['dcloud']);
    expect(s.deployment.fn.dcloud.profile).toBe('fn');
    expect(s.profiles.placement.dcloud.pricing.fn.denom).toBe('uact');
    expect(s.profiles.compute.fn.resources.gpu.attributes.vendor.nvidia[0].model).toBe('a100');
  });

  it('treats a single-element gpuGroups as a single-group deploy with that GPU', () => {
    const s = parse(buildSdlString({ ...base, gpuGroups: [{ vendor: 'nvidia', model: 'h100' }] }, 'img:1'));
    expect(Object.keys(s.deployment.fn)).toEqual(['dcloud']);
    expect(s.profiles.compute.fn.resources.gpu.attributes.vendor.nvidia[0].model).toBe('h100');
  });
});

describe('buildSdlString — multi-group fan-out', () => {
  const groups: GpuSpec[] = [
    { vendor: 'nvidia', model: 'a100' },
    { vendor: 'nvidia', model: 'h100' },
    { vendor: 'nvidia', model: 'l40' },
  ];
  const sdl = () => parse(buildSdlString({ ...base, gpuGroups: groups }, 'img:1'));

  it('maps ONE `fn` service under N placement groups', () => {
    const s = sdl();
    expect(Object.keys(s.services)).toEqual(['fn']);
    expect(Object.keys(s.deployment.fn)).toEqual(['g00', 'g01', 'g02']);
  });

  it('names groups zero-padded so declaration order === alphabetical order', () => {
    const names = Object.keys(sdl().deployment.fn);
    expect(names).toEqual(['g00', 'g01', 'g02']);
    expect([...names].sort()).toEqual(names);
  });

  it('gives each group its own compute profile with the right GPU model, in candidate order', () => {
    const s = sdl();
    expect(s.profiles.compute.g00.resources.gpu.attributes.vendor.nvidia[0].model).toBe('a100');
    expect(s.profiles.compute.g01.resources.gpu.attributes.vendor.nvidia[0].model).toBe('h100');
    expect(s.profiles.compute.g02.resources.gpu.attributes.vendor.nvidia[0].model).toBe('l40');
  });

  it('prices each placement in uact for its own compute profile', () => {
    const s = sdl();
    expect(s.profiles.placement.g00.pricing.g00.denom).toBe('uact');
    expect(s.profiles.placement.g01.pricing.g01.denom).toBe('uact');
    expect(s.deployment.fn.g00.profile).toBe('g00');
    expect(s.deployment.fn.g01.profile).toBe('g01');
    expect(s.deployment.fn.g00.count).toBe(1);
  });

  it('shares cpu/memory/storage across all groups (only the GPU differs)', () => {
    const s = sdl();
    expect(s.profiles.compute.g00.resources.cpu).toEqual(s.profiles.compute.g01.resources.cpu);
    expect(s.profiles.compute.g00.resources.memory).toEqual(s.profiles.compute.g01.resources.memory);
    expect(s.profiles.compute.g00.resources.storage).toEqual(s.profiles.compute.g01.resources.storage);
  });

  it('keeps the single fn service’s job env (EXECUTION_KIND, DEPLOYMENT_ID)', () => {
    const env = sdl().services.fn.env;
    expect(env).toContain('EXECUTION_KIND=job');
    expect(env).toContain('DEPLOYMENT_ID=dep-1');
  });
});
