interface PromptTextOptions {
    defaultValue?: string;
    required?: boolean;
}
interface PromptSecretOptions {
    required?: boolean;
}
export interface MultiSelectOption<TValue extends string> {
    value: TValue;
    label: string;
}
export declare function closePromptResources(): void;
export declare function promptText(label: string, options?: PromptTextOptions): Promise<string>;
export declare function promptSecret(label: string, options?: PromptSecretOptions): Promise<string>;
export declare function promptMultiSelect<TValue extends string>(label: string, options: readonly MultiSelectOption<TValue>[], defaults?: readonly TValue[]): Promise<TValue[]>;
export {};
//# sourceMappingURL=prompts.d.ts.map