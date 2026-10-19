/** The map is optional: if its style cannot be loaded the lists below it must keep working. */
export const MAP_LOAD_TIMEOUT_MS = 20_000;

export type MapLoadStatus = 'loading' | 'ready' | 'failed';

export interface MapLoad {
  status: MapLoadStatus;
  /** Bumped by every retry: used as the key that remounts the native map. */
  attempt: number;
}

export type MapLoadEvent = 'loaded' | 'failed' | 'timeout' | 'retry';

export const INITIAL_MAP_LOAD: MapLoad = { status: 'loading', attempt: 0 };

export function reduceMapLoad(state: MapLoad, event: MapLoadEvent): MapLoad {
  switch (event) {
    case 'loaded':
      return state.status === 'ready' ? state : { ...state, status: 'ready' };
    case 'failed':
      // A style that already loaded stays on screen when later requests fail (tiles come and go offline).
      return state.status === 'loading' ? { ...state, status: 'failed' } : state;
    case 'timeout':
      return state.status === 'loading' ? { ...state, status: 'failed' } : state;
    case 'retry':
      return state.status === 'failed' ? { status: 'loading', attempt: state.attempt + 1 } : state;
  }
}
