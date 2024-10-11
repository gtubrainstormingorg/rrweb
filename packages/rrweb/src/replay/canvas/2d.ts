import type { Replayer } from '../';
import type { canvasMutationCommand } from 'howdygo-rrweb-types';
import { deserializeArg } from './deserialize-args';

// A map to track active mutation promises by `id`
const activeMutations = new Map<Number, Map<number, { cancelled: boolean }>>();

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

  // Create a unique execution ID (using timestamp)
  const executionId = Date.now();

  // Initialize the map for this `id` if it doesn't exist
  if (!activeMutations.has(id)) {
    activeMutations.set(id, new Map<number, { cancelled: boolean }>());
  }

  // Add this specific execution to the map and mark it as active
  activeMutations.get(id)?.set(executionId, { cancelled: false });

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
      if (activeMutations.has(id) && activeMutations.get(id)?.get(executionId)?.cancelled) {
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
  activeMutations.get(id)?.forEach((value, key) => {
    if (key !== executionId) {
      value.cancelled = true;
    }
  });

  // Wait for the mutation to finish
  await mutationPromise;

  // Clean up: Remove the mutation from the map when done
  activeMutations.get(id)?.delete(executionId);

  // If no more executions are active for this `id`, remove the entry
  if (activeMutations.get(id)?.size === 0) {
    activeMutations.delete(id);
  }
}