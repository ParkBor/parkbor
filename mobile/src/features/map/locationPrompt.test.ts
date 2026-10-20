import { afterEach, describe, expect, it } from 'vitest';

import { locationPrompt } from '@/features/map/locationPrompt';

afterEach(() => locationPrompt.clear());

describe('locationPrompt', () => {
  it('may prompt by default', () => {
    expect(locationPrompt.mayPromptOnMount()).toBe(true);
  });

  it('does not prompt on its own after "Later"', () => {
    locationPrompt.defer();
    expect(locationPrompt.mayPromptOnMount()).toBe(false);
  });

  it('a location action lifts the deferral', () => {
    locationPrompt.defer();
    locationPrompt.clear();
    expect(locationPrompt.mayPromptOnMount()).toBe(true);
  });
});
