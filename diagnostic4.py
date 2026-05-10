import unsloth
import os, json
import torch
import transformers


os.environ["HSA_OVERRIDE_GFX_VERSION"] = "11.5.1"

from unsloth import FastLanguageModel, is_bfloat16_supported, PatchDPOTrainer
from torch.utils.data import Dataset
from trl import DPOConfig, DPOTrainer

PatchDPOTrainer()

MODEL_PATH   = "/run/media/eas/LOGOS/0/llm-workspace/models/Logos-remapped"
DATASET_PATH = "dpo_merged.jsonl"
OUTPUT_DIR   = "/run/media/eas/DATA/AI/Unsloth/dpo_output"

MAX_LENGTH        = 2048
MAX_PROMPT_LENGTH = 1024
LABEL_PAD_ID      = -100


def tokenize_row_for_dpo(row, tokenizer):
    """
    Pre-tokenizes a DPO row using a plain text tokenizer, producing the exact
    field names that TRL's DPODataCollatorWithPadding expects.  This bypasses
    DPOTrainer's internal tokenize_row, which would call the multimodal
    tokenizer and inject image tokens.
    """
    prompt_enc = tokenizer(
        row['prompt'],
        truncation=True,
        max_length=MAX_PROMPT_LENGTH,
        add_special_tokens=True,
    )
    prompt_ids  = prompt_enc['input_ids']
    prompt_mask = prompt_enc['attention_mask']
    prompt_len  = len(prompt_ids)

    response_budget = MAX_LENGTH - prompt_len

    chosen_enc = tokenizer(
        row['chosen'],
        truncation=True,
        max_length=response_budget,
        add_special_tokens=False,
    )
    rejected_enc = tokenizer(
        row['rejected'],
        truncation=True,
        max_length=response_budget,
        add_special_tokens=False,
    )

    chosen_ids    = (prompt_ids  + chosen_enc['input_ids'])[:MAX_LENGTH]
    chosen_mask   = (prompt_mask + chosen_enc['attention_mask'])[:MAX_LENGTH]
    rejected_ids  = (prompt_ids  + rejected_enc['input_ids'])[:MAX_LENGTH]
    rejected_mask = (prompt_mask + rejected_enc['attention_mask'])[:MAX_LENGTH]

    # Mask the prompt portion in labels so loss is only on the response
    chosen_labels   = [LABEL_PAD_ID] * prompt_len + chosen_enc['input_ids']
    chosen_labels   = chosen_labels[:MAX_LENGTH]
    rejected_labels = [LABEL_PAD_ID] * prompt_len + rejected_enc['input_ids']
    rejected_labels = rejected_labels[:MAX_LENGTH]

    return {
        'prompt_input_ids':        prompt_ids,
        'prompt_attention_mask':   prompt_mask,
        'chosen_input_ids':        chosen_ids,
        'chosen_attention_mask':   chosen_mask,
        'chosen_labels':           chosen_labels,
        'rejected_input_ids':      rejected_ids,
        'rejected_attention_mask': rejected_mask,
        'rejected_labels':         rejected_labels,
    }


class JsonlMapDataset(Dataset):
    def __init__(self, rows):
        self.rows = rows

    @classmethod
    def from_jsonl(cls, path):
        rows = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    row = json.loads(line)
                    clean_row = {k: row[k] for k in ('prompt', 'chosen', 'rejected') if k in row}
                    rows.append(clean_row)
        return cls(rows)

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        return self.rows[idx]

    def map(self, fn, fn_kwargs=None, **kwargs):
        if fn_kwargs is None:
            fn_kwargs = {}
        mapped = []
        for row in self.rows:
            out = fn(row, **fn_kwargs)
            if out is None:
                mapped.append(row)
            elif isinstance(out, dict):
                merged = dict(row)
                merged.update(out)
                mapped.append(merged)
            else:
                mapped.append(out)
        return JsonlMapDataset(mapped)


raw_dataset = JsonlMapDataset.from_jsonl(DATASET_PATH)
print(f"Loaded {len(raw_dataset)} rows, keys: {list(raw_dataset[0].keys())}")

print("Loading model...")

model, tokenizer = FastLanguageModel.from_pretrained(
    MODEL_PATH,
    max_seq_length=MAX_LENGTH,
    dtype=None,
    load_in_4bit=False,
    load_in_8bit=True,
    load_in_16bit=False,
    device_map="auto",
    trust_remote_code=True,
)

from transformers import AutoTokenizer
text_tokenizer = AutoTokenizer.from_pretrained(
    MODEL_PATH,
    trust_remote_code=False,
    use_fast=False,
)

if text_tokenizer.pad_token is None:
    text_tokenizer.pad_token = text_tokenizer.eos_token
text_tokenizer.padding_side = "right"

model.config.pad_token_id = text_tokenizer.pad_token_id

# Force text-only model behavior
if hasattr(model.config, "vision_config"):
    model.config.vision_config = None
if hasattr(model.config, 'image_token_id'):
    model.config.image_token_id = -100
if hasattr(model.config, 'mm_projector_type'):
    del model.config.mm_projector_type
if hasattr(model.config, 'image_processor_type'):
    del model.config.image_processor_type
model.config.is_multimodal = False

# Dummy image loader so any stray image-path code paths are harmless
transformers.image_utils.load_image = lambda image: \
    transformers.image_utils.PILImage.frombytes("RGB", (1, 1), b"\x00\x00\x00")

print("Vision configs cleared; image processor patched")

print("Applying LoRA...")
model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    lora_alpha=32,
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=3407,
    max_seq_length=MAX_LENGTH,
)

# Pre-tokenize with the plain text tokenizer so DPOTrainer never touches the
# multimodal tokenizer path.  After this the dataset rows already have all the
# keys TRL's DPODataCollatorWithPadding expects.
print("Pre-tokenizing dataset with text_tokenizer...")
dataset = raw_dataset.map(tokenize_row_for_dpo, fn_kwargs={"tokenizer": text_tokenizer})
print(f"Pre-tokenized {len(dataset)} rows, keys: {list(dataset[0].keys())}")

# Block DPOTrainer from calling map() again so it cannot re-tokenize via the
# multimodal tokenizer.  self-reference is safe because dataset is already final.
dataset.map = lambda *args, **kwargs: dataset

print("Setting up DPO trainer...")
trainer = DPOTrainer(
    model=model,
    ref_model=None,
    tokenizer=text_tokenizer,
    train_dataset=dataset,
    beta=0.1,
    args=DPOConfig(
        output_dir=OUTPUT_DIR,
        max_length=MAX_LENGTH,
        max_prompt_length=MAX_PROMPT_LENGTH,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        num_train_epochs=3,
        max_steps=1,
        learning_rate=5e-6,
        warmup_steps=10,
        weight_decay=0.01,
        max_grad_norm=1.0,
        bf16=is_bfloat16_supported(),
        fp16=not is_bfloat16_supported(),
        optim="adamw_8bit",
        logging_steps=5,
        save_strategy="steps",
        save_steps=50,
        seed=3407,
        report_to="none",
        remove_unused_columns=False,
        dataloader_pin_memory=False,
    ),
)

print("Starting training...")
trainer.train()

print("Saving adapter...")
model.save_pretrained(OUTPUT_DIR)
text_tokenizer.save_pretrained(OUTPUT_DIR)
print(f"Done — adapter in {OUTPUT_DIR}")
