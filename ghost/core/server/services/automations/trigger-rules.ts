import { DbDate } from '../../lib/db-types/date';
import errors from '@tryghost/errors';
import ObjectId from 'bson-objectid';
import type { ReadonlyDeep } from 'type-fest';
import { z } from 'zod';
import type { AutomationTriggerTierScope } from './automations-repository-2';

export const automationTriggerRuleDefinitionSchema = z.union([
  z.object({
    trigger_type: z.literal('free_signup'),
    scope: z.null(),
    product_id: z.null(),
  }),
  z.object({
    trigger_type: z.literal('paid_subscription_started'),
    scope: z.literal('any_paid_tier'),
    product_id: z.null(),
  }),
  z.object({
    trigger_type: z.literal('paid_subscription_started'),
    scope: z.literal('specific_paid_tier'),
    product_id: z.string(),
  }),
]);

export type AutomationTriggerRuleDefinition = z.infer<typeof automationTriggerRuleDefinitionSchema>;

export const automationTriggerRuleSchema = automationTriggerRuleDefinitionSchema.and(
  z.object({
    id: z.string(),
    automation_id: z.string(),
    created_at: DbDate,
  }),
);

export type AutomationTriggerRule = z.infer<typeof automationTriggerRuleSchema>;

export function buildTriggerRuleRows({
  automationId,
  scope,
  tierIds,
  createdAt,
}: ReadonlyDeep<{
  automationId: string;
  scope: AutomationTriggerTierScope;
  tierIds: string[];
  createdAt: Date;
}>): AutomationTriggerRule[] {
  let rules: AutomationTriggerRuleDefinition[];
  switch (scope) {
    case 'free':
      rules = [{ trigger_type: 'free_signup', scope: null, product_id: null }];
      break;
    case 'all_paid':
      rules = [
        { trigger_type: 'paid_subscription_started', scope: 'any_paid_tier', product_id: null },
      ];
      break;
    case 'selected_paid':
      rules = [...new Set(tierIds)].map((productId) => ({
        trigger_type: 'paid_subscription_started',
        scope: 'specific_paid_tier',
        product_id: productId,
      }));
      break;
    default: {
      const _exhaustive: never = scope;
      throw new errors.InternalServerError({
        message: `Unexpected automation trigger tier scope: ${_exhaustive}`,
      });
    }
  }
  return rules.map((rule) => ({
    ...rule,
    id: ObjectId().toHexString(),
    automation_id: automationId,
    created_at: createdAt,
  }));
}
