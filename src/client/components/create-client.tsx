import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { strings } from "@/lib/strings";

export function CreateClient({ onClose }: { onClose: () => void }) {
  const { addClient, setError } = useApp();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) { setError(strings.nameRequired); return; }
    setSaving(true);
    try {
      await addClient({ name: name.trim(), email, phone, notes });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Agregar cliente</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Nombre *</Label>
            <Input value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Nombre completo" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Correo electrónico</Label>
              <Input type="email" value={email} onChange={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="email@example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Teléfono</Label>
              <Input value={phone} onChange={(e) => setPhone((e.target as HTMLInputElement).value)} placeholder="555-0100" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notas</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes((e.target as HTMLTextAreaElement).value)} placeholder="Preferencias, alergias, etc." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={saving} onClick={handleSubmit}>{saving ? strings.saving : "Agregar cliente"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
