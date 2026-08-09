import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url().optional(),
  TRANSLATION_MEDIA_PUBLIC_WSS_URL: z.string().url().optional(),
  APP_STREAM_PUBLIC_WSS_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TRANSLATION_MODEL: z.string().default('gpt-realtime-translate'),
  OPENAI_SAFETY_IDENTIFIER: z.string().default('bridge-phone-call-prototype'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  BRIDGE_MEDIA_SHARED_SECRET: z.string().min(16).optional(),
  BRIDGE_MEDIA_API_KEY: z.string().min(16).optional(),
  DRY_RUN_CALLS: z
    .string()
    .optional()
    .transform((value) => value == null || value.toLowerCase() === 'true')
});

export type AppConfig = z.infer<typeof envSchema>;

export function getConfig(): AppConfig {
  return envSchema.parse(process.env);
}

export function twilioConfigured(config: AppConfig): boolean {
  return Boolean(
    config.TWILIO_ACCOUNT_SID &&
      config.TWILIO_PHONE_NUMBER &&
      (config.TWILIO_AUTH_TOKEN || (config.TWILIO_API_KEY_SID && config.TWILIO_API_KEY_SECRET))
  );
}

export function openAiConfigured(config: AppConfig): boolean {
  return Boolean(config.OPENAI_API_KEY);
}

export function mediaRouterConfigured(config: AppConfig): boolean {
  return Boolean(config.PUBLIC_BASE_URL && config.TRANSLATION_MEDIA_PUBLIC_WSS_URL && config.APP_STREAM_PUBLIC_WSS_URL);
}
