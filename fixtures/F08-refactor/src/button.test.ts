import { expect, it } from 'vitest';

import { Button } from './button';
import { useOverlay } from './overlay';

it('renders the overlay label', () => {
  expect(Button('save')).toBe('SAVE');
  expect(useOverlay('cancel').label()).toBe('CANCEL');
});
