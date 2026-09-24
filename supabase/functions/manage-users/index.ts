import "@supabase/functions-js/edge-runtime.d.ts"
import { withSupabase } from "@supabase/server"

type StaffRole = "veterinarian" | "reception"

interface CreateUserRequest {
  email?: unknown
  displayName?: unknown
  role?: unknown
  password?: unknown
}

interface DeleteRequest {
  userId?: unknown
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status })
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST" && req.method !== "DELETE") {
      return errorResponse("Método no permitido.", 405)
    }

    const callerId = ctx.userClaims?.id
    if (!callerId) {
      return errorResponse("La sesión no es válida.", 401)
    }

    const { data: caller, error: callerError } = await ctx.supabaseAdmin
      .from("profiles")
      .select("role, is_active")
      .eq("id", callerId)
      .single()

    if (callerError || !caller || !caller.is_active || caller.role !== "owner") {
      return errorResponse("Solo el usuario dueño puede administrar usuarios.", 403)
    }

    let input: CreateUserRequest | DeleteRequest
    try {
      input = await req.json()
    } catch {
      return errorResponse("La solicitud no contiene datos válidos.", 400)
    }

    if (req.method === "DELETE") {
      const deleteInput = input as DeleteRequest
      const userId = typeof deleteInput.userId === "string" ? deleteInput.userId.trim() : ""
      if (!uuidPattern.test(userId)) {
        return errorResponse("El usuario indicado no es válido.", 400)
      }
      if (userId === callerId) {
        return errorResponse("El usuario dueño no puede eliminar su propia cuenta.", 400)
      }

      const { data: target, error: targetError } = await ctx.supabaseAdmin
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .single()

      if (targetError || !target) {
        return errorResponse("El usuario ya no existe.", 404)
      }
      if (target.role === "owner") {
        return errorResponse("La cuenta del dueño no se puede eliminar.", 400)
      }

      const { error: deleteError } = await ctx.supabaseAdmin.auth.admin.deleteUser(userId, false)
      if (deleteError) {
        console.error("Could not delete Auth user", deleteError)
        return errorResponse("No fue posible eliminar el usuario. Intenta de nuevo.", 500)
      }

      const { error: auditError } = await ctx.supabaseAdmin.from("audit_events").insert({
        actor_id: callerId,
        action: "DELETE",
        entity_table: "profiles",
        entity_id: userId,
      })
      if (auditError) console.error("Could not record Auth user deletion", auditError)

      return Response.json({
        message: "Usuario eliminado. Su actividad y sus archivos se conservaron.",
      })
    }

    const createInput = input as CreateUserRequest
    const email = typeof createInput.email === "string" ? createInput.email.trim().toLowerCase() : ""
    const displayName = typeof createInput.displayName === "string" ? createInput.displayName.trim() : ""
    const password = typeof createInput.password === "string" ? createInput.password : ""
    const role = createInput.role as StaffRole

    if (!emailPattern.test(email) || email.length > 254) {
      return errorResponse("Escribe un correo electrónico válido.", 400)
    }
    if (displayName.length < 2 || displayName.length > 120) {
      return errorResponse("El nombre debe tener entre 2 y 120 caracteres.", 400)
    }
    if (role !== "veterinarian" && role !== "reception") {
      return errorResponse("Selecciona un rol permitido.", 400)
    }
    if (password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      return errorResponse("La contraseña debe tener al menos 10 caracteres, una mayúscula, una minúscula y un número.", 400)
    }

    const { data: created, error: createError } = await ctx.supabaseAdmin.auth.admin
      .createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      })

    if (createError || !created.user) {
      const detail = createError?.message.toLowerCase() ?? ""
      const duplicate = detail.includes("already") || detail.includes("registered") || detail.includes("exists")
      const invalidPassword = detail.includes("password")
      return errorResponse(
        duplicate
          ? "Ya existe una cuenta con ese correo."
          : invalidPassword
            ? "Supabase rechazó la contraseña. Usa una contraseña distinta y más segura."
            : "No fue posible crear el acceso. Revisa los datos e intenta de nuevo.",
        duplicate ? 409 : 400,
      )
    }

    const { data: profile, error: profileError } = await ctx.supabaseAdmin
      .from("profiles")
      .update({ display_name: displayName, role })
      .eq("id", created.user.id)
      .select("id")
      .single()

    if (profileError || !profile) {
      console.error("User created but profile update failed", profileError)
      const { error: rollbackError } = await ctx.supabaseAdmin.auth.admin.deleteUser(created.user.id, false)
      if (rollbackError) console.error("Could not roll back incomplete user", rollbackError)
      return errorResponse("No fue posible asignar el rol; el acceso no fue habilitado. Intenta de nuevo.", 500)
    }

    const { error: auditError } = await ctx.supabaseAdmin.from("audit_events").insert({
      actor_id: callerId,
      action: "INSERT",
      entity_table: "profiles",
      entity_id: created.user.id,
    })
    if (auditError) console.error("Could not record Auth user creation", auditError)

    return Response.json({
      message: "Acceso creado y listo para usarse.",
      user: {
        id: created.user.id,
        email,
        displayName,
        role,
      },
    })
  }),
}
