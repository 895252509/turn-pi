import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, KeyRound } from 'lucide-react';
import type { CredentialCard } from '@/lib/types';

/**
 * 供应商 API Key 环境变量的组合框：
 * 同一个输入框既能直接输入变量名，也能从 env 层凭据里选。
 */
export function CredentialEnvPicker({
	id,
	value,
	options,
	placeholder,
	onChange,
}: {
	id: string;
	value: string;
	options: CredentialCard[];
	placeholder?: string;
	onChange: (value: string) => void;
}) {
	const [text, setText] = useState(value);
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		setText(value);
	}, [value]);

	const query = text.trim().toLowerCase();
	const filtered = options.filter((item) => {
		if (!query) return true;
		return [item.envName, item.name, item.label]
			.filter(Boolean)
			.some((part) => String(part).toLowerCase().includes(query));
	});
	const activeIndex = filtered.length ? Math.min(active, filtered.length - 1) : 0;

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (wrapRef.current?.contains(event.target as Node)) return;
			setOpen(false);
		};
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	}, [open]);

	const commit = (next: string) => {
		setText(next);
		onChange(next);
	};

	const select = (item: CredentialCard) => {
		if (!item.envName) return;
		commit(item.envName);
		setOpen(false);
		inputRef.current?.focus();
	};

	return (
		<div ref={wrapRef} className={`credential-env-combo${open ? ' open' : ''}`}>
			<input
				ref={inputRef}
				id={id}
				role="combobox"
				aria-expanded={open}
				aria-controls={`${id}-options`}
				aria-autocomplete="list"
				aria-activedescendant={
					open && filtered[activeIndex] ? `${id}-option-${filtered[activeIndex].id}` : undefined
				}
				value={text}
				placeholder={placeholder}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => commit(event.target.value)}
				onFocus={() => {
					if (options.length) {
						setOpen(true);
						setActive(0);
					}
				}}
				onKeyDown={(event) => {
					if (event.key === 'ArrowDown') {
						event.preventDefault();
						if (!open) setOpen(true);
						setActive((current) => Math.min(current + 1, Math.max(0, filtered.length - 1)));
					} else if (event.key === 'ArrowUp') {
						event.preventDefault();
						setActive((current) => Math.max(0, current - 1));
					} else if (event.key === 'Enter' && open && filtered[activeIndex]) {
						event.preventDefault();
						select(filtered[activeIndex]);
					} else if (event.key === 'Escape') {
						setOpen(false);
					}
				}}
			/>
			<button
				type="button"
				className="credential-env-combo-toggle"
				aria-label={open ? '收起凭据列表' : '选择凭据'}
				title={open ? '收起凭据列表' : '选择凭据'}
				tabIndex={-1}
				onClick={() => {
					setOpen((current) => !current);
					setActive(0);
					inputRef.current?.focus();
				}}
			>
				<ChevronDown aria-hidden="true" />
			</button>

			{open ? (
				<div id={`${id}-options`} className="credential-env-menu" role="listbox">
					{filtered.length ? (
						filtered.map((item, index) => (
							<button
								key={item.id}
								id={`${id}-option-${item.id}`}
								type="button"
								role="option"
								aria-selected={item.envName === value}
								className={`credential-env-option${index === activeIndex ? ' active' : ''}${
									item.envName === value ? ' selected' : ''
								}`}
								onMouseEnter={() => setActive(index)}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => select(item)}
							>
								<span className="credential-env-option-icon">
									<KeyRound aria-hidden="true" />
								</span>
								<span className="credential-env-option-copy">
									<strong>{item.label || item.name}</strong>
									<small>{item.envName}</small>
								</span>
								{item.envName === value ? <Check aria-hidden="true" /> : null}
							</button>
						))
					) : (
						<div className="credential-env-empty">可直接输入环境变量名</div>
					)}
				</div>
			) : null}
		</div>
	);
}
