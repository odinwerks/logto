import type {
  RespondentSessionVerificationRequest,
  RespondentSessionVerificationResponse,
  RespondentUserStatusResponse,
} from '@logto/schemas';

import { authedAdminApi } from './api.js';

export const getRespondentUserStatus = async (userId: string) =>
  authedAdminApi.get(`users/${userId}/status`).json<RespondentUserStatusResponse>();

export const verifyRespondentSession = async (
  userId: string,
  payload: RespondentSessionVerificationRequest
) =>
  authedAdminApi
    .post(`users/${userId}/session-verifications`, { json: payload })
    .json<RespondentSessionVerificationResponse>();
