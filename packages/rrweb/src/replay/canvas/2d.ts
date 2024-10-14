import type { Replayer } from '../';
import type { canvasMutationCommand } from 'howdygo-rrweb-types';
import { deserializeArg } from './deserialize-args';

// A map to track active mutation promises by `id`
const activeCanvasMutations = new Map<Number, Map<string, { cancelled: boolean }>>();

export default async function canvasMutation({
  event,
  mutations,
  target,
  imageMap,
  id,
  errorHandler,
}: {
  event: Parameters<Replayer['applyIncremental']>[0];
  mutations: canvasMutationCommand[];
  target: HTMLCanvasElement;
  imageMap: Replayer['imageMap'];
  id: Number;
  errorHandler: Replayer['warnCanvasMutationFailed'];
}): Promise<void> {
  const ctx = target.getContext('2d');

  if (!ctx) {
    errorHandler(mutations[0], new Error('Canvas context is null'));
    return;
  }

  // Create a unique execution ID (using timestamp and random string)
  const executionId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  // Initialize the map for this `id` if it doesn't exist
  if (!activeCanvasMutations.has(id)) {
    activeCanvasMutations.set(id, new Map<string, { cancelled: boolean }>());
  }

  // Add this specific execution to the map and mark it as active
  activeCanvasMutations.get(id)?.set(executionId, { cancelled: false });

  const mutationPromise = (async () => {
    try {
      // Step 1: Deserialize args (they may be async)
      const mutationArgsPromises = mutations.map(
        async (mutation: canvasMutationCommand): Promise<unknown[]> => {
          return Promise.all(mutation.args.map(deserializeArg(imageMap, ctx)));
        },
      );

      const args = await Promise.all(mutationArgsPromises);

      // Step 2: Check for cancellation before applying mutations
      if (
        activeCanvasMutations.has(id) &&
        activeCanvasMutations.get(id)?.get(executionId)?.cancelled
      ) {
        return; // Skip mutation application
      }

      // Step 3: Apply all mutations
      args.forEach((args, index) => {
        const mutation = mutations[index];
        try {
          if (mutation.setter) {
            // Skip some read-only type checks
            (ctx as unknown as Record<string, unknown>)[mutation.property] =
              mutation.args[0];
            return;
          }
          const original = ctx[
            mutation.property as Exclude<keyof typeof ctx, 'canvas'>
          ] as (ctx: CanvasRenderingContext2D, args: unknown[]) => void;

          // Special case for drawImage
          if (
            mutation.property === 'drawImage' &&
            typeof mutation.args[0] === 'string'
          ) {
            imageMap.get(event);
            original.apply(ctx, mutation.args);
          } else {
            original.apply(ctx, args);
          }
        } catch (error) {
          errorHandler(mutation, error);
        }
      });
    } catch (error) {
      errorHandler(mutations[0], error);
    }
  })();

  // If a new mutation for this `id` is started, mark this execution as cancelled
  activeCanvasMutations.get(id)?.forEach((value, key) => {
    if (key !== executionId) {
      value.cancelled = true;
    }
  });

  // Wait for the mutation to finish
  await mutationPromise;

  // Clean up: Remove the mutation from the map when done
  activeCanvasMutations.get(id)?.delete(executionId);

  // If no more executions are active for this `id`, remove the entry
  if (activeCanvasMutations.get(id)?.size === 0) {
    activeCanvasMutations.delete(id);
  }
}
