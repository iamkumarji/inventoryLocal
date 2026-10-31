import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { api, unwrap } from "@/api/client";
import { PhotoField } from "@/components/photo";
import { Body, Button, Heading, Input, Loading, Notice, Screen } from "@/components/ui";
import { expenseClaim, isMoney, today, type Photo } from "@/lib/operations";
import { useQueue } from "@/lib/queue/provider";
import { useLoad } from "@/lib/use-load";

type Category = { id: string; code: string; name: string; per_claim_limit: string | null; receipt_required_above: string | null; requires_vehicle: boolean };

/** Compares decimal strings without floats. */
function above(amount: string, limit: string | null): boolean {
  if (!limit) return false;
  const norm = (v: string) => {
    const [w, f = ""] = v.split(".");
    return BigInt(w) * 10000n + BigInt((f + "0000").slice(0, 4));
  };
  return norm(amount) > norm(limit);
}

export default function NewExpense() {
  const { enqueue } = useQueue();
  const { data: categories, error, loading } = useLoad(async () => {
    const page = await unwrap(api.GET("/api/v1/expenses/categories/", { params: { query: { is_active: true, page_size: 100 } } }));
    // Vehicle expenses need odometer details: those go through fuel logs on the web app.
    return ((page.results ?? []) as unknown as Category[]).filter((c) => !c.requires_vehicle);
  }, []);
  const [category, setCategory] = useState<Category | null>(null);
  const [purpose, setPurpose] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [receipt, setReceipt] = useState<Photo | null>(null);

  const amountOk = isMoney(amount);
  const overLimit = amountOk && category && above(amount, category.per_claim_limit);
  const needsReceipt = amountOk && category && category.receipt_required_above !== null && above(amount, category.receipt_required_above);
  const ready = category && purpose.trim() && description.trim() && amountOk && !overLimit && (!needsReceipt || receipt);

  const save = async () => {
    if (!ready || !category) return;
    await enqueue(
      "expense_claim",
      `Expense: ${description.trim()} (${amount.trim()})`,
      expenseClaim({ claimDate: today(), purpose: purpose.trim(), category: category.id, description: description.trim(), amount: amount.trim(), receipt }),
    );
    router.replace("/queue");
  };

  if (loading) return <Loading />;
  return (
    <Screen>
      <Heading sub="Submitted for approval when it reaches the server">New expense</Heading>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ gap: 8 }}>
        <Body muted>Category</Body>
        {categories?.length === 0 ? <Notice tone="warn">No expense categories are available to you. Ask finance to set them up.</Notice> : null}
        {categories?.map((c) => (
          <Button key={c.id} testID={`category-${c.code}`} title={c.name} kind={category?.id === c.id ? "primary" : "secondary"} onPress={() => setCategory(c)} />
        ))}
      </View>
      <Input testID="purpose" label="Purpose" value={purpose} onChangeText={setPurpose} />
      <Input testID="description" label="What was it for" value={description} onChangeText={setDescription} />
      <Input
        testID="amount"
        label="Amount (₹)"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        error={amount && !amountOk ? "Enter an amount with up to 2 decimals." : overLimit ? `Above the ${category?.name} limit of ₹${category?.per_claim_limit}.` : undefined}
      />
      <PhotoField testID="receipt" label={needsReceipt ? "Receipt photo (required for this amount)" : "Receipt photo"} value={receipt} onChange={setReceipt} />
      <Button testID="save-expense" title="Submit expense" onPress={save} disabled={!ready} />
    </Screen>
  );
}
