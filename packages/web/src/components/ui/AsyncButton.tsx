import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Icon } from '../icons';

type Props = ComponentPropsWithoutRef<'button'> & {
  loading?: boolean;
  loadingText?: ReactNode;
  spinnerSize?: number;
};

export const AsyncButton = forwardRef<HTMLButtonElement, Props>(function AsyncButton(
  { loading, loadingText, spinnerSize = 11, disabled, type, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <>
          <Icon name="spinner" size={spinnerSize} className="spin" />
          {loadingText ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
});
