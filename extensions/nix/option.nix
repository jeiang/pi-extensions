o:
let
  safe = v: let r = builtins.tryEval (builtins.toJSON v); in if r.success then builtins.fromJSON (builtins.unsafeDiscardStringContext r.value) else "<not serializable>";
  text = d: if builtins.isAttrs d then d.text or (safe d) else d;
in
if (o._type or null) == "option" then {
  type = o.type.description or o.type.name or null;
  default = if o ? defaultText then text o.defaultText else if o ? default then safe o.default else null;
  description = if o ? description then text o.description else null;
  declarations = map toString (o.declarations or [ ]);
  value = safe o.value;
} else {
  children = builtins.attrNames o;
}
