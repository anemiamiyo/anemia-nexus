import { useOverlay } from './overlay';
import './styles/theme.scss';

export function Button(label: string): string {
  const controller = useOverlay(label);
  return controller.label();
}
