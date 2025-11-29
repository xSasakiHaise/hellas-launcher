const fetch = require('node-fetch');

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '00000000402b5328';
const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore';
const DEVICE_SCOPE = 'XboxLive.signin offline_access';

async function requestDeviceCode() {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    scope: DEVICE_SCOPE,
    response_type: 'device_code'
  });

  const response = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) {
    throw new Error('Failed to start Microsoft device authorization.');
  }

  const payload = await response.json();
  if (!payload.device_code) {
    throw new Error('Device authorization response was missing required fields.');
  }

  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    expiresAt: Date.now() + (payload.expires_in || 900) * 1000,
    interval: Math.max(5, payload.interval || 5),
    message: payload.message || ''
  };
}

async function exchangeDeviceCode(deviceCode) {
  const params = new URLSearchParams({
    grant_type: 'device_code',
    client_id: MICROSOFT_CLIENT_ID,
    code: deviceCode
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const payload = await response.json();
  if (!response.ok || payload.error) {
    return { error: payload.error || 'unknown_error', description: payload.error_description };
  }

  return payload;
}

async function refreshMicrosoftToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: MICROSOFT_CLIENT_ID,
    refresh_token: refreshToken
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error_description || 'Failed to refresh Microsoft login.');
  }

  return payload;
}

async function authenticateXboxLive(accessToken) {
  const response = await fetch(XBL_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${accessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error('Xbox Live authentication failed.');
  }

  return payload;
}

async function authorizeXsts(userToken) {
  const response = await fetch(XSTS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [userToken]
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error('Xbox security token service authorization failed.');
  }

  return payload;
}

async function exchangeForMinecraft(xsts) {
  const response = await fetch(MC_LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${xsts.DisplayClaims.xui[0].uhs};${xsts.Token}` })
  });

  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error('Minecraft authentication failed.');
  }

  return payload.access_token;
}

async function ensureMinecraftOwnership(mcAccessToken) {
  const response = await fetch(MC_ENTITLEMENTS_URL, {
    headers: { Authorization: `Bearer ${mcAccessToken}` }
  });

  if (!response.ok) {
    throw new Error('Failed to validate Minecraft entitlements.');
  }

  const payload = await response.json();
  if (!payload.items || payload.items.length === 0) {
    throw new Error('No Minecraft entitlements found for this account.');
  }
}

async function fetchMinecraftProfile(mcAccessToken) {
  const response = await fetch(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${mcAccessToken}` }
  });

  if (!response.ok) {
    throw new Error('Failed to fetch Minecraft profile.');
  }

  const payload = await response.json();
  if (!payload.name) {
    throw new Error('Minecraft profile is missing account information.');
  }

  return { username: payload.name, uuid: payload.id };
}

async function buildSessionFromMicrosoftToken(msTokenPayload) {
  const xbl = await authenticateXboxLive(msTokenPayload.access_token);
  const xsts = await authorizeXsts(xbl.Token);
  const mcAccessToken = await exchangeForMinecraft(xsts);
  await ensureMinecraftOwnership(mcAccessToken);
  const profile = await fetchMinecraftProfile(mcAccessToken);

  return {
    username: profile.username,
    uuid: profile.uuid,
    accessToken: mcAccessToken,
    refreshToken: msTokenPayload.refresh_token
  };
}

async function pollDeviceCode(deviceCode) {
  const tokenResponse = await exchangeDeviceCode(deviceCode);
  if (tokenResponse.error) {
    if (tokenResponse.error === 'authorization_pending') {
      return { status: 'pending' };
    }
    if (tokenResponse.error === 'slow_down') {
      return { status: 'slow_down' };
    }
    if (tokenResponse.error === 'authorization_declined') {
      return { status: 'declined', message: 'Sign-in was declined.' };
    }
    if (tokenResponse.error === 'expired_token' || tokenResponse.error === 'code_expired') {
      return { status: 'expired', message: 'Device code expired. Please start again.' };
    }

    return { status: 'error', message: tokenResponse.description || 'Login failed.' };
  }

  const session = await buildSessionFromMicrosoftToken(tokenResponse);
  return { status: 'success', session };
}

async function loginWithRefreshToken(refreshToken) {
  const msToken = await refreshMicrosoftToken(refreshToken);
  return buildSessionFromMicrosoftToken(msToken);
}

module.exports = {
  requestDeviceCode,
  pollDeviceCode,
  loginWithRefreshToken
};
