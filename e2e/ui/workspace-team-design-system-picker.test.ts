import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

test('[P0] local design systems remain selectable without a Team catalog', async ({ page }) => {
  await applyStandardMocks(page);
  const created = await page.request.post('/api/design-systems', {
    data: { title: 'Local Product Language', summary: 'Local picker witness', category: 'Custom', status: 'published' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const body = await created.json() as { id?: string; designSystem?: { id: string } };
  const id = body.id ?? body.designSystem?.id;
  expect(id).toBeTruthy();
  const cloudRequests: string[] = [];
  page.on('request', request => {
    if (/\/api\/workspace\/(design-systems|events)/.test(new URL(request.url()).pathname)) cloudRequests.push(request.url());
  });
  await page.goto('/');
  const trigger = page.getByTestId('home-hero-design-system-trigger');
  await expect(trigger).toBeVisible({ timeout: T.long });
  await trigger.click();
  const picker = page.getByTestId('project-ds-picker-popover');
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId('project-ds-picker-group-team')).toHaveCount(0);
  const option = picker.getByTestId(`project-ds-picker-option-${id}`);
  await expect(option).toBeVisible();
  await option.click();
  await expect(trigger).toContainText('Local Product Language');
  expect(cloudRequests).toEqual([]);
});
