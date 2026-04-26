import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

import { uploadAvatarAsset } from '@/components/hub-cat-editor.client';

describe('uploadAvatarAsset size gate', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    // Default to a successful response so that without a size gate the function would resolve.
    // The Red→Green transition is driven by whether the size gate prevents the fetch call.
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ url: '/uploads/x.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('rejects raw file larger than the avatar limit before sending request', async () => {
    const oversized = new File([new ArrayBuffer(11 * 1024 * 1024)], 'big.png', {
      type: 'image/png',
    });
    await expect(uploadAvatarAsset(oversized)).rejects.toThrow(/过大|too large/i);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('forwards request when file size is within the avatar limit', async () => {
    const small = new File([new Uint8Array(1024)], 'small.png', { type: 'image/png' });
    const url = await uploadAvatarAsset(small);
    expect(url).toBe('/uploads/x.png');
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });
});
