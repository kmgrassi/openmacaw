import { forwardRef } from "react";
import type { ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";

import { buttonClassName, type ButtonSize, type ButtonVariant } from "./Button";

type ButtonLinkProps = LinkProps & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
};

export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      children,
      leftIcon,
      rightIcon,
      ...props
    },
    ref,
  ) => (
    <Link
      ref={ref}
      className={buttonClassName({ variant, size, className })}
      {...props}
    >
      {leftIcon && <span className="mr-2 inline-flex">{leftIcon}</span>}
      {children}
      {rightIcon && <span className="ml-2 inline-flex">{rightIcon}</span>}
    </Link>
  ),
);
ButtonLink.displayName = "ButtonLink";
